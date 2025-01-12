/*
* Vieb - Vim Inspired Electron Browser
* Copyright (C) 2019-2021 Jelmer van Arnhem
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/
"use strict"

const {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    net,
    screen,
    session,
    shell,
    webContents
} = require("electron")
const {ElectronBlocker} = require("@cliqz/adblocker-electron")
const isSvg = require("is-svg")
const {
    specialChars,
    writeJSON,
    readJSON,
    writeFile,
    readFile,
    isDir,
    listDir,
    expandPath,
    deleteFile,
    isFile,
    joinPath,
    makeDir,
    dirname,
    basePath,
    formatSize,
    extractZip,
    isAbsolutePath
} = require("./util")
const {"sync": rimrafSync} = require("rimraf")
const rimraf = pattern => {
    try {
        rimrafSync(pattern)
    } catch (_) {
        // Permission errors
    }
}

const version = process.env.npm_package_version || app.getVersion()
const printUsage = (code = 1) => {
    console.info(`Vieb: Vim Inspired Electron Browser

Usage: Vieb [options] <URLs>

Options:
 --help                  Print this help and exit.

 --version               Print program info with versions and exit.

 --debug                 Open with Chromium and Electron debugging tools.
                         They can also be opened later with ':internaldevtools'.

 --datafolder=<dir>      Store ALL Vieb data in this folder.
                         You can also use the ENV var: 'VIEB_DATAFOLDER'.

 --erwic=<file>          file: Location of the JSON file to configure Erwic.
                         Open a fixed set of pages in a separate instance.
                         See 'Erwic.md' or ':h erwic' for usage and details.
                         You can also use the ENV var: 'VIEB_ERWIC'.

 --config-order=<val>    string [USER-FIRST/user-only/
                           datafolder-first/datafolder-only/none]:
                         Configure the viebrc config file parse order.
                         You can choose to load either of the locations first,
                         choose to load only one of the locations or no config.
                         Order arg is ignored if '--config-file' is provided.
                         See ':h viebrc' for viebrc locations and details.
                         You can also use the ENV var: 'VIEB_CONFIG_ORDER'.

 --config-file=<file>    Parse only a single viebrc config file when starting.
                         If a file is provided using thsi argument,
                         the '--config-order' argument will be set to 'none'.
                         Also see ':h viebrc' for viebrc locations and details.
                         You can also use the ENV var: 'VIEB_CONFIG_FILE'.

 --window-frame=<val>    bool (false): Show the native frame around the window.
                         You can also use the ENV var: 'VIEB_WINDOW_FRAME'.

 --media-keys=<val>      bool (true): Allow the media keys to control playback.
                         You can also use the ENV var: 'VIEB_MEDIA_KEYS'.

 --site-isolation=<val>  string [REGULAR/strict]: Set the site isolation level.
                         You can also use the ENV var: 'VIEB_SITE_ISOLATION'.

 --acceleration=<val>    string [HARDWARE/software]: Use hardware acceleration.
                         You can also use the ENV var: 'VIEB_ACCELERATION'.

All arguments not starting with - will be opened as a url.
Command-line arguments will overwrite values set by ENV vars.`)
    printLicense()
    app.exit(code)
}
const printVersion = () => {
    console.info(`Vieb: Vim Inspired Electron Browser
This is version ${version} of Vieb.
Vieb is based on Electron and inspired by Vim.
It can be used to browse the web entirely with the keyboard.
This release uses Electron ${process.versions.electron} and Chromium ${
    process.versions.chrome}`)
    printLicense()
    app.exit(0)
}
const printLicense = () => {
    console.info(`Vieb is created by Jelmer van Arnhem and contributors.
Website: https://vieb.dev OR https://github.com/Jelmerro/Vieb

License: GNU GPL version 3 or later versions <http://gnu.org/licenses/gpl.html>
This is free software; you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.
See the LICENSE file or the GNU website for details.`)
}
const applyDevtoolsSettings = prefFile => {
    makeDir(dirname(prefFile))
    const preferences = readJSON(prefFile) || {}
    if (!preferences.electron) {
        preferences.electron = {}
    }
    if (!preferences.electron.devtools) {
        preferences.electron.devtools = {}
    }
    if (!preferences.electron.devtools.preferences) {
        preferences.electron.devtools.preferences = {}
    }
    // Disable source maps as they leak internal structure to the webserver
    preferences.electron.devtools.preferences.cssSourceMapsEnabled = false
    preferences.electron.devtools.preferences.jsSourceMapsEnabled = false
    // Disable release notes, most are not relevant for Vieb
    preferences.electron.devtools.preferences["help.show-release-note"] = false
    // Show timestamps in the console
    preferences.electron.devtools.preferences.consoleTimestampsEnabled = true
    // Enable dark theme
    preferences.electron.devtools.preferences.uiTheme = `"dark"`
    writeJSON(prefFile, preferences)
}
const useragent = () => session.defaultSession.getUserAgent()
    .replace(/Electron\/\S* /, "").replace(/Vieb\/\S* /, "")
    .replace(RegExp(`${app.getName()}/\\S* `), "")

// Parse arguments
const getArguments = argv => {
    const execFile = basePath(argv[0])
    if (execFile === "electron" || process.defaultApp && execFile !== "vieb") {
        // The array argv is ["electron", "app", ...args]
        return argv.slice(2)
    }
    // The array argv is ["vieb", ...args]
    return argv.slice(1)
}
const isTruthyArg = arg => {
    const argStr = String(arg).trim().toLowerCase()
    return Number(argStr) > 0 || ["y", "yes", "true", "on"].includes(argStr)
}
const args = getArguments(process.argv)
const urls = []
let argDebugMode = false
let argDatafolder = process.env.VIEB_DATAFOLDER?.trim()
    || joinPath(app.getPath("appData"), "Vieb")
let argErwic = process.env.VIEB_ERWIC?.trim() || ""
let argWindowFrame = isTruthyArg(process.env.VIEB_WINDOW_FRAME)
let argConfigOrder = process.env.VIEB_CONFIG_ORDER?.trim().toLowerCase()
    || "user-first"
let argConfigOverride = process.env.VIEB_CONFIG_FILE?.trim().toLowerCase() || ""
let argMediaKeys = isTruthyArg(process.env.VIEB_MEDIA_KEYS)
let argSiteIsolation = process.env.VIEB_SITE_ISOLATION?.trim().toLowerCase()
    || "regular"
let argAcceleration = process.env.VIEB_ACCELERATION?.trim().toLowerCase()
    || "hardware"
let customIcon = null
args.forEach(a => {
    const arg = a.trim()
    if (arg.startsWith("-")) {
        if (arg === "--help") {
            printUsage(0)
        } else if (arg === "--version") {
            printVersion()
        } else if (arg === "--debug") {
            argDebugMode = true
        } else if (arg === "--datafolder") {
            console.warn("The 'datafolder' argument requires a value such as:"
                + " --datafolder=~/.config/Vieb/\n")
            printUsage()
        } else if (arg === "--erwic") {
            console.warn("The 'erwic' argument requires a value such as:"
                + " --erwic=~/.config/Erwic/\n")
            printUsage()
        } else if (arg === "--config-order") {
            console.warn("The 'config-order' argument requires a value such as:"
                + " --config-order=user-first\n")
            printUsage()
        } else if (arg === "--config-file") {
            console.warn("The 'config-file' argument requires a value such as:"
                + " --config-file=./customconf\n")
            printUsage()
        } else if (arg === "--window-frame") {
            console.warn("The 'window-frame' argument requires a value such as:"
                + " --window-frame=false\n")
            printUsage()
        } else if (arg === "--media-keys") {
            console.warn("The 'media-keys' argument requires a value such as:"
                + " --media-keys=true\n")
            printUsage()
        } else if (arg === "--site-isolation") {
            console.warn("The 'site-isolation' argument requires a value such "
                + "as: --site-isolation=regular\n")
            printUsage()
        } else if (arg === "--acceleration") {
            console.warn("The 'acceleration' argument requires a value such as:"
                + "\n --acceleration=hardware\n")
            printUsage()
        } else if (arg.startsWith("--datafolder=")) {
            argDatafolder = arg.split("=").slice(1).join("=")
        } else if (arg.startsWith("--erwic=")) {
            argErwic = arg.split("=").slice(1).join("=")
        } else if (arg.startsWith("--config-order=")) {
            argConfigOrder = arg.split("=").slice(1).join("=")
        } else if (arg.startsWith("--config-file=")) {
            argConfigOverride = arg.split("=").slice(1).join("=")
        } else if (arg.startsWith("--window-frame=")) {
            argWindowFrame = isTruthyArg(arg.split("=").slice(1).join("="))
        } else if (arg.startsWith("--media-keys=")) {
            argMediaKeys = isTruthyArg(arg.split("=").slice(1).join("="))
        } else if (arg.startsWith("--site-isolation=")) {
            argSiteIsolation = arg.split("=").slice(1).join("=").toLowerCase()
        } else if (arg.startsWith("--acceleration=")) {
            argAcceleration = arg.split("=").slice(1).join("=").toLowerCase()
        } else {
            console.warn(`Unsupported argument: '${arg}', use --help for info`)
        }
    } else {
        urls.push(arg)
    }
})
if (argSiteIsolation !== "regular" && argSiteIsolation !== "strict") {
    console.warn("The 'site-isolation' argument only accepts:\n"
        + "'regular' or 'strict'\n")
    printUsage()
}
if (argAcceleration !== "hardware" && argAcceleration !== "software") {
    console.warn("The 'acceleration' argument only accepts:\n"
        + "'hardware' or 'software'\n")
    printUsage()
}
if (!argDatafolder.trim()) {
    console.warn("The 'datafolder' argument may not be empty\n")
    printUsage()
}
const validConfigOrders = [
    "none", "user-only", "datafolder-only", "user-first", "datafolder-first"
]
if (!validConfigOrders.includes(argConfigOrder)) {
    console.warn(`The 'config-order' argument only accepts:\n${
        validConfigOrders.slice(0, -1).map(c => `'${c}'`).join(", ")} or '${
        validConfigOrders.slice(-1)[0]}'\n`)
    printUsage()
}
if (argConfigOverride) {
    argConfigOverride = expandPath(argConfigOverride)
    if (!isAbsolutePath(argConfigOverride)) {
        argConfigOverride = joinPath(process.cwd(), argConfigOverride)
    }
    if (!isFile(argConfigOverride)) {
        console.warn("Config file could not be read\n")
        printUsage()
    }
}
// Fix segfault when opening Twitter:
// https://github.com/electron/electron/issues/25469
app.commandLine.appendSwitch("disable-features", "CrossOriginOpenerPolicy")
if (argSiteIsolation === "regular") {
    app.commandLine.appendSwitch("disable-site-isolation-trials")
}
if (argAcceleration === "software") {
    app.disableHardwareAcceleration()
}
if (!argMediaKeys) {
    app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling")
}
rimraf("Partitions/temp*")
rimraf("erwicmode")
app.setName("Vieb")
argDatafolder = `${joinPath(expandPath(argDatafolder.trim()))}/`
app.setPath("appData", argDatafolder)
app.setPath("userData", argDatafolder)
applyDevtoolsSettings(joinPath(argDatafolder, "Preferences"))
if (argErwic) {
    argErwic = expandPath(argErwic)
    const config = readJSON(argErwic)
    if (!config) {
        console.warn("Erwic config file could not be read\n")
        printUsage()
    }
    if (config.name) {
        app.setName(config.name)
    }
    if (config.icon) {
        config.icon = expandPath(config.icon)
        if (config.icon !== joinPath(config.icon)) {
            config.icon = joinPath(dirname(argErwic), config.icon)
        }
        if (!isFile(config.icon)) {
            config.icon = null
        }
        customIcon = config.icon
    }
    writeFile(joinPath(argDatafolder, "erwicmode"), "")
    if (!Array.isArray(config.apps)) {
        console.warn("Erwic config file requires a list of 'apps'\n")
        printUsage()
    }
    config.apps = config.apps.map(a => {
        const simpleContainerName = a.container.replace(/_/g, "")
        if (simpleContainerName.match(specialChars)) {
            console.warn("Container names are not allowed to have "
                + "special characters besides underscores\n")
            printUsage()
        }
        if (typeof a.script === "string") {
            a.script = expandPath(a.script)
            if (a.script !== joinPath(a.script)) {
                a.script = joinPath(dirname(argErwic), a.script)
            }
        } else {
            a.script = null
        }
        return a
    }).filter(a => typeof a.container === "string" && typeof a.url === "string")
    if (config.apps.length === 0) {
        console.warn("Erwic config file requires at least one app to be added")
        console.warn("Each app must have a 'container' name and a 'url'\n")
        printUsage()
    }
    urls.push(...config.apps)
}

// When the app is ready to start, open the main window
let mainWindow = null
let loginWindow = null
let notificationWindow = null
const resolveLocalPaths = (paths, cwd = null) => paths.filter(u => u).map(u => {
    const url = u.url || u
    let fileLocation = expandPath(url.replace(/^file:\/*/g, "/"))
    if (process.platform === "win32") {
        fileLocation = expandPath(url.replace(/^file:\/*/g, ""))
    }
    if (!isAbsolutePath(fileLocation)) {
        fileLocation = joinPath(cwd || process.cwd(), url)
    }
    if (isFile(fileLocation)) {
        return `file:///${fileLocation.replace(/^\//g, "")}`
    }
    if (url.startsWith("-")) {
        return null
    }
    return {...u, url}
}).filter(u => u)
app.on("ready", () => {
    app.userAgentFallback = useragent()
    if (app.requestSingleInstanceLock()) {
        app.on("second-instance", (_, newArgs, cwd) => {
            if (mainWindow.isMinimized()) {
                mainWindow.restore()
            }
            mainWindow.focus()
            mainWindow.webContents.send("urls", resolveLocalPaths(
                getArguments(newArgs), cwd))
        })
    } else {
        console.info(`Sending urls to existing instance in ${argDatafolder}`)
        app.exit(0)
    }
    app.on("open-url", (_, url) => mainWindow.webContents.send("urls",
        resolveLocalPaths([url])))
    if (!app.isPackaged && !customIcon) {
        customIcon = joinPath(__dirname, "img/icons/512x512.png")
    }
    // Init mainWindow
    const windowData = {
        "closable": false,
        "frame": argWindowFrame,
        "height": 600,
        "icon": customIcon,
        "show": argDebugMode,
        "title": app.getName(),
        "webPreferences": {
            "contextIsolation": false,
            "disableBlinkFeatures": "Auxclick",
            "enableRemoteModule": false,
            "nativeWindowOpen": false,
            "nodeIntegration": false,
            "preload": joinPath(__dirname, "renderer/index.js"),
            "sandbox": false,
            "webviewTag": true
        },
        "width": 800
    }
    mainWindow = new BrowserWindow(windowData)
    mainWindow.removeMenu()
    mainWindow.setMinimumSize(500, 500)
    mainWindow.on("close", e => {
        e.preventDefault()
        mainWindow.webContents.send("window-close")
    })
    mainWindow.on("closed", () => {
        app.exit(0)
    })
    mainWindow.on("app-command", (e, cmd) => {
        mainWindow.webContents.send("app-command", cmd)
        e.preventDefault()
    })
    // Load app and send urls when ready
    mainWindow.loadURL(`file://${joinPath(__dirname, "index.html")}`)
    mainWindow.webContents.once("did-finish-load", () => {
        mainWindow.webContents.on("new-window", e => e.preventDefault())
        mainWindow.webContents.on("will-navigate", e => e.preventDefault())
        mainWindow.webContents.on("will-redirect", e => e.preventDefault())
        mainWindow.webContents.on("will-attach-webview", (_, prefs) => {
            delete prefs.preloadURL
            prefs.preload = joinPath(__dirname, "preload/index.js")
            prefs.nodeIntegration = false
            prefs.nodeIntegrationInSubFrames = false
            prefs.contextIsolation = false
            prefs.enableRemoteModule = false
            prefs.webSecurity = argSiteIsolation === "strict"
        })
        if (argDebugMode) {
            mainWindow.webContents.openDevTools({"mode": "undocked"})
        }
        mainWindow.webContents.send("urls", resolveLocalPaths(urls))
    })
    // Show a dialog for sites requiring Basic HTTP authentication
    const loginWindowData = {
        "alwaysOnTop": true,
        "frame": false,
        "fullscreenable": false,
        "icon": customIcon,
        "modal": true,
        "parent": mainWindow,
        "resizable": false,
        "show": false,
        "webPreferences": {
            "contextIsolation": true,
            "disableBlinkFeatures": "Auxclick",
            "enableRemoteModule": false,
            "nodeIntegration": false,
            "partition": "login",
            "preload": joinPath(__dirname, "preload/loginpopup.js"),
            "sandbox": true
        }
    }
    loginWindow = new BrowserWindow(loginWindowData)
    const loginPage = `file:///${joinPath(__dirname, "pages/loginpopup.html")}`
    loginWindow.loadURL(loginPage)
    loginWindow.on("close", e => {
        e.preventDefault()
        loginWindow.hide()
        mainWindow.focus()
    })
    ipcMain.on("hide-login-window", () => {
        loginWindow.hide()
        mainWindow.focus()
    })
    // Show a dialog for large notifications
    const notificationWindowData = {
        "alwaysOnTop": true,
        "frame": false,
        "fullscreenable": false,
        "icon": customIcon,
        "modal": true,
        "parent": mainWindow,
        "resizable": false,
        "show": false,
        "webPreferences": {
            "contextIsolation": true,
            "disableBlinkFeatures": "Auxclick",
            "enableRemoteModule": false,
            "nodeIntegration": false,
            "partition": "notification-window",
            "preload": joinPath(__dirname, "preload/notificationpopup.js"),
            "sandbox": true
        }
    }
    notificationWindow = new BrowserWindow(notificationWindowData)
    const notificationPage = `file:///${joinPath(
        __dirname, "pages/notificationpopup.html")}`
    notificationWindow.loadURL(notificationPage)
    notificationWindow.on("close", e => {
        e.preventDefault()
        notificationWindow.hide()
        mainWindow.focus()
    })
    ipcMain.on("hide-notification-window", () => {
        notificationWindow.hide()
        mainWindow.focus()
    })
})

// THIS ENDS THE MAIN SETUP, ACTIONS BELOW MUST BE IN MAIN FOR VARIOUS REASONS

// Handle Basic HTTP login attempts
const loginAttempts = []
let fontsize = 14
let customCSS = ""
ipcMain.on("set-custom-styling", (_, newFontSize, newCSS) => {
    fontsize = newFontSize
    customCSS = newCSS
})
app.on("login", (e, contents, _, auth, callback) => {
    if (loginWindow.isVisible()) {
        return
    }
    if (loginAttempts.includes(contents.id)) {
        loginAttempts.splice(loginAttempts.indexOf(contents.id), 1)
        return
    }
    e.preventDefault()
    loginAttempts.push(contents.id)
    loginWindow.removeAllListeners("hide")
    loginWindow.once("hide", () => {
        try {
            callback("", "")
        } catch (err) {
            // Window was already closed
        }
    })
    ipcMain.removeAllListeners("login-credentials")
    ipcMain.once("login-credentials", (__, credentials) => {
        try {
            callback(credentials[0], credentials[1])
            loginWindow.hide()
            mainWindow.focus()
        } catch (err) {
            // Window is already being closed
        }
    })
    const bounds = mainWindow.getBounds()
    const size = Math.round(fontsize * 21)
    loginWindow.setMinimumSize(size, size)
    loginWindow.setSize(size, size)
    loginWindow.setPosition(
        Math.round(bounds.x + bounds.width / 2 - size / 2),
        Math.round(bounds.y + bounds.height / 2 - size / 2))
    loginWindow.resizable = false
    loginWindow.show()
    loginWindow.focus()
    loginWindow.webContents.send("login-information",
        fontsize, customCSS, `${auth.host}: ${auth.realm}`)
})

// Show a scrollable notification popup for long notifications
ipcMain.on("show-notification", (_, escapedMessage, properType) => {
    const bounds = mainWindow.getBounds()
    const width = Math.round(bounds.width * 0.9)
    let height = Math.round(bounds.height * 0.9)
    height -= height % fontsize
    notificationWindow.setMinimumSize(width, height)
    notificationWindow.setSize(width, height)
    notificationWindow.setPosition(
        Math.round(bounds.x + bounds.width / 2 - width / 2),
        Math.round(bounds.y + bounds.height / 2 - height / 2))
    notificationWindow.webContents.send("notification-details",
        escapedMessage, fontsize, customCSS, properType)
    notificationWindow.show()
    notificationWindow.focus()
})

// Create and manage sessions, mostly downloads, adblocker and permissions
const dlsFile = joinPath(app.getPath("appData"), "dls")
let downloadSettings = {}
let downloads = []
let redirects = ""
let blocker = null
let permissions = {}
const sessionList = []
const adblockerPreload = require.resolve("@cliqz/adblocker-electron-preload")
ipcMain.on("set-redirects", (_, rdr) => {
    redirects = rdr
})
ipcMain.on("open-download", (_, location) => shell.openPath(location))
ipcMain.on("set-download-settings", (_, settings) => {
    if (Object.keys(downloadSettings).length === 0) {
        if (settings.cleardownloadsonquit) {
            deleteFile(dlsFile)
        } else if (isFile(dlsFile)) {
            downloads = readJSON(dlsFile)?.map(d => {
                if (d.state !== "completed") {
                    d.state = "cancelled"
                }
                return d
            }) || []
        }
    }
    downloadSettings = settings
    if (downloadSettings.cleardownloadsoncompleted) {
        downloads = downloads.filter(d => d.state !== "completed")
    }
    downloadSettings.downloadpath = expandPath(downloadSettings.downloadpath)
})
ipcMain.on("download-list-request", (e, action, downloadId) => {
    if (action === "removeall") {
        downloads.forEach(download => {
            try {
                download.item.cancel()
            } catch (_) {
                // Download was already removed or is already done
            }
        })
        downloads = []
    }
    if (action === "pause") {
        try {
            downloads[downloadId].item.pause()
        } catch (_) {
            // Download just finished or some other silly reason
        }
    }
    if (action === "resume") {
        try {
            downloads[downloadId].item.resume()
        } catch (_) {
            // Download can't be resumed
        }
    }
    if (action === "remove") {
        try {
            downloads[downloadId].state = "removed"
            downloads[downloadId].item.cancel()
        } catch (_) {
            // Download was already removed from the list or something
        }
        try {
            downloads.splice(downloadId, 1)
        } catch (_) {
            // Download was already removed from the list or something
        }
    }
    writeDownloadsToFile()
    e.sender.send("download-list", JSON.stringify(downloads))
})
ipcMain.on("set-permissions", (_, permissionObject) => {
    permissions = permissionObject
})
ipcMain.on("set-spelllang", (_, langs) => {
    if (!langs) {
        return
    }
    const parsedLangs = langs.split(",").map(l => {
        let lang = l
        if (lang === "system") {
            lang = app.getLocale()
        }
        const valid = session.defaultSession.availableSpellCheckerLanguages
        if (!valid.includes(lang)) {
            return null
        }
        return lang
    }).filter(lang => lang)
    sessionList.forEach(ses => {
        session.fromPartition(ses).setSpellCheckerLanguages(parsedLangs)
        session.defaultSession.setSpellCheckerLanguages(parsedLangs)
    })
})
ipcMain.on("create-session", (_, name, adblock, cache) => {
    if (sessionList.includes(name)) {
        return
    }
    const partitionDir = joinPath(app.getPath("appData"), "Partitions")
    const sessionDir = joinPath(partitionDir, encodeURIComponent(
        name.split(":")[1] || name))
    applyDevtoolsSettings(joinPath(sessionDir, "Preferences"))
    const newSession = session.fromPartition(name, {cache})
    newSession.setPermissionRequestHandler(permissionHandler)
    newSession.setPermissionCheckHandler(() => true)
    sessionList.push(name)
    if (adblock !== "off") {
        if (blocker) {
            reloadAdblocker()
        } else {
            enableAdblocker(adblock)
        }
    }
    listDir(joinPath(argDatafolder, "extensions"), true, true)?.forEach(loc => {
        newSession.loadExtension(loc, {"allowFileAccess": true})
    })
    newSession.webRequest.onBeforeRequest((details, callback) => {
        let url = String(details.url)
        redirects.split(",").forEach(r => {
            if (r.trim()) {
                const [match, replace] = r.split("~")
                url = url.replace(RegExp(match), replace)
            }
        })
        if (details.url !== url) {
            return callback({"cancel": false, "redirectURL": url})
        }
        if (!blocker) {
            return callback({"cancel": false})
        }
        blocker.onBeforeRequest(details, callback)
    })
    newSession.webRequest.onHeadersReceived((details, callback) => {
        if (!blocker) {
            return callback({"cancel": false})
        }
        blocker.onHeadersReceived(details, callback)
    })
    newSession.on("will-download", (e, item) => {
        if (downloadSettings.downloadmethod === "block") {
            e.preventDefault()
            return
        }
        const filename = item.getFilename()
        let save = joinPath(downloadSettings.downloadpath, filename)
        let duplicateNumber = 1
        let newFilename = item.getFilename()
        while (isFile(save)) {
            duplicateNumber += 1
            const extStart = filename.lastIndexOf(".")
            if (extStart === -1) {
                newFilename = `${filename} (${duplicateNumber})`
            } else {
                newFilename = `${filename.substring(0, extStart)} (${
                    duplicateNumber}).${filename.substring(extStart + 1)}`
            }
            save = joinPath(downloadSettings.downloadpath, newFilename)
        }
        if (downloadSettings.downloadmethod !== "ask") {
            item.setSavePath(save)
        }
        if (downloadSettings.downloadmethod === "confirm") {
            let wrappedFileName = filename.replace(/.{50}/g, "$&\n")
            if (wrappedFileName.length > 1000) {
                wrappedFileName = `${wrappedFileName.split("")
                    .slice(0, 1000).join("")}...`
            }
            let wrappedUrl = item.getURL()
            try {
                wrappedUrl = decodeURI(wrappedUrl)
            } catch (__) {
                // Invalid url
            }
            wrappedUrl = wrappedUrl.replace(/.{50}/g, "$&\n")
            if (wrappedUrl.length > 1000) {
                wrappedUrl = `${wrappedUrl.split("")
                    .slice(0, 1000).join("")}...`
            }
            const button = dialog.showMessageBoxSync(mainWindow, {
                "buttons": ["Allow", "Deny"],
                "cancelId": 1,
                "defaultId": 0,
                "message": `Do you want to download the following file?\n\n${
                    wrappedFileName}\n\n${item.getMimeType()} - ${
                    formatSize(item.getTotalBytes())}\n\n${wrappedUrl}`,
                "title": "Download request from the website",
                "type": "question"
            })
            if (button === 1) {
                e.preventDefault()
                return
            }
        }
        const info = {
            "current": 0,
            "date": new Date(),
            "file": item.getSavePath(),
            item,
            "name": filename,
            "state": "waiting_to_start",
            "total": item.getTotalBytes(),
            "url": item.getURL()
        }
        downloads.push(info)
        mainWindow.webContents.send("notify", `Download started:\n${info.name}`)
        item.on("updated", (__, state) => {
            try {
                info.current = item.getReceivedBytes()
                info.file = item.getSavePath()
                info.total = item.getTotalBytes()
                if (state === "progressing" && !item.isPaused()) {
                    info.state = "downloading"
                } else {
                    info.state = "paused"
                }
            } catch (___) {
                // When a download is finished before the event is detected,
                // the item will throw an error for all the mapped functions.
            }
            writeDownloadsToFile()
        })
        item.once("done", (__, state) => {
            if (state === "completed") {
                info.state = "completed"
                if (downloadSettings.cleardownloadsoncompleted) {
                    downloads = downloads.filter(d => d.state !== "completed")
                }
            } else if (info.state !== "removed") {
                info.state = "cancelled"
            }
            if (info.state === "completed") {
                mainWindow.webContents.send("notify",
                    `Download finished:\n${info.name}`, "success", {
                        "path": info.file, "type": "download-success"
                    })
            } else {
                mainWindow.webContents.send("notify",
                    `Download failed:\n${info.name}`, "warn")
            }
        })
    })
})
const cancellAllDownloads = () => {
    downloads.forEach(download => {
        try {
            if (download.state !== "completed") {
                download.state = "cancelled"
            }
            download.item.cancel()
        } catch (e) {
            // Download was already removed or is already done
        }
    })
    writeDownloadsToFile()
}
const writeDownloadsToFile = () => {
    downloads.forEach(d => {
        // Update downloads that are stuck on waiting to start,
        // but have already been destroyed by electron.
        try {
            d.item.getFilename()
        } catch (e) {
            if (d.state === "waiting_to_start") {
                d.state = "completed"
            }
        }
    })
    if (downloadSettings.cleardownloadsonquit || downloads.length === 0) {
        deleteFile(dlsFile)
    } else {
        writeJSON(dlsFile, downloads)
    }
}
const permissionHandler = (_, perm, callback, details) => {
    let permission = perm.toLowerCase().replace(/-/g, "")
    if (permission === "mediakeysystem") {
        // Block any access to DRM, there is no Electron support for it anyway
        return callback(false)
    }
    if (permission === "media") {
        if (details.mediaTypes?.includes("video")) {
            permission = "camera"
        } else if (details.mediaTypes?.includes("audio")) {
            permission = "microphone"
        } else {
            permission = "displaycapture"
        }
    }
    let permissionName = `permission${permission}`
    let setting = permissions[permissionName]
    if (!setting) {
        permissionName = "permissionunknown"
        setting = permissions.permissionunknown
    }
    let settingRule = ""
    for (const override of ["asked", "blocked", "allowed"]) {
        const permList = permissions[`permissions${override}`]?.split(",")
        for (const rule of permList || []) {
            if (!rule.trim() || settingRule) {
                continue
            }
            const [match, ...names] = rule.split("~")
            if (names.find(p => permissionName.endsWith(p))) {
                if (details.requestingUrl.match(match)) {
                    settingRule = override.replace("ed", "")
                }
            }
        }
    }
    setting = settingRule || setting
    if (setting === "ask") {
        let url = details.requestingUrl
        if (url.length > 100) {
            url = url.replace(/.{50}/g, "$&\n")
        }
        if (url.length > 1000) {
            url = `${url.split("").slice(0, 1000).join("")}...`
        }
        let message = "The page has requested access to the permission "
            + `'${permission}'. You can allow or deny this below, and choose if`
            + " you want to make this the default for the current session when "
            + "sites ask for this permission. For help and more options, see "
            + `':h ${permissionName}', ':h permissionsallowed', ':h permissions`
            + `asked' and ':h permissionsblocked'.\n\npage:\n${url}`
        if (permission === "openexternal") {
            let exturl = details.externalURL
            if (exturl.length > 100) {
                exturl = exturl.replace(/.{50}/g, "$&\n")
            }
            if (exturl.length > 1000) {
                exturl = `${exturl.split("").slice(0, 1000).join("")}...`
            }
            message = "The page has requested to open an external application."
                + " You can allow or deny this below, and choose if you want to"
                + " make this the default for the current session when sites "
                + "ask to open urls in external programs. For help and more "
                + "options, see ':h permissionopenexternal', ':h permissionsall"
                + "owed', ':h permissionsasked' and ':h permissionsblocked'.\n"
                + `\npage:\n${details.requestingUrl}\n\nexternal:\n${exturl}`
        }
        dialog.showMessageBox(mainWindow, {
            "buttons": ["Allow", "Deny"],
            "cancelId": 1,
            "checkboxLabel": "Remember for this session",
            "defaultId": 0,
            message,
            "title": `Allow this page to access '${permission}'?`,
            "type": "question"
        }).then(e => {
            let action = "allow"
            if (e.response !== 0) {
                action = "block"
            }
            if (settingRule) {
                mainWindow.webContents.send("notify",
                    `Ask rule for '${permission}' activated at '`
                    + `${details.requestingUrl}' which was ${action}ed by user`,
                    "perm")
            } else {
                mainWindow.webContents.send("notify",
                    `Manually ${action}ed '${permission}' at `
                    + `'${details.requestingUrl}'`, "perm")
            }
            callback(action === "allow")
            const canSave = action !== "allow"
                || permission !== "displaycapture"
            if (e.checkboxChecked && canSave) {
                mainWindow.webContents.send(
                    "set-permission", permissionName, action)
                permissions[permissionName] = action
            }
        })
    } else {
        if (settingRule) {
            mainWindow.webContents.send("notify",
                `Automatic rule for '${permission}' activated at `
                + `'${details.requestingUrl}' which was ${setting}ed`,
                "perm")
        } else {
            mainWindow.webContents.send("notify",
                `Globally ${setting}ed '${permission}' at `
                + `'${details.requestingUrl}' based on '${permissionName}'`,
                "perm")
        }
        callback(setting === "allow")
    }
}
const blocklistDir = joinPath(app.getPath("appData"), "blocklists")
const defaultBlocklists = {
    "easylist": "https://easylist.to/easylist/easylist.txt",
    "easyprivacy": "https://easylist.to/easylist/easyprivacy.txt"
}
const enableAdblocker = type => {
    makeDir(blocklistDir)
    // Copy the default and included blocklists to the appdata folder
    if (type !== "custom") {
        for (const name of Object.keys(defaultBlocklists)) {
            const list = joinPath(__dirname, `./blocklists/${name}.txt`)
            writeFile(joinPath(blocklistDir, `${name}.txt`), readFile(list))
        }
    }
    // And update default blocklists to the latest version if enabled
    if (type === "update") {
        for (const list of Object.keys(defaultBlocklists)) {
            mainWindow.webContents.send("notify",
                `Updating ${list} to the latest version`)
            session.fromPartition("persist:main")
            const request = net.request(
                {"partition": "persist:main", "url": defaultBlocklists[list]})
            request.on("response", res => {
                let body = ""
                res.on("end", () => {
                    writeFile(joinPath(blocklistDir, `${list}.txt`), body)
                    reloadAdblocker()
                    mainWindow.webContents.send("notify",
                        `Updated and reloaded the latest ${list} successfully`,
                        "suc")
                })
                res.on("data", chunk => {
                    body += chunk
                })
            })
            request.on("abort", e => mainWindow.webContents.send("notify",
                `Failed to update ${list}:\n${e.message}`, "err"))
            request.on("error", e => mainWindow.webContents.send("notify",
                `Failed to update ${list}:\n${e.message}`, "err"))
            request.end()
        }
    } else {
        reloadAdblocker()
    }
}
const reloadAdblocker = () => {
    if (blocker) {
        disableAdblocker()
    }
    const blocklistsFolders = [
        joinPath(app.getPath("appData"), "blocklists"),
        expandPath("~/.vieb/blocklists")
    ]
    let filters = ""
    for (const blocklistsFolder of blocklistsFolders) {
        listDir(blocklistsFolder, true)?.forEach(file => {
            if (file.endsWith(".txt")) {
                filters += loadBlocklist(file)
            }
        })
    }
    blocker = ElectronBlocker.parse(filters)
    ipcMain.on("get-cosmetic-filters", blocker.onGetCosmeticFilters)
    ipcMain.on("is-mutation-observer-enabled",
        blocker.onIsMutationObserverEnabled)
    sessionList.forEach(part => {
        const ses = session.fromPartition(part)
        ses.setPreloads(ses.getPreloads().concat([adblockerPreload]))
    })
}
const disableAdblocker = () => {
    if (!blocker) {
        return
    }
    ipcMain.removeListener("get-cosmetic-filters", blocker.onGetCosmeticFilters)
    ipcMain.removeListener("is-mutation-observer-enabled",
        blocker.onIsMutationObserverEnabled)
    blocker = null
    sessionList.forEach(part => {
        const ses = session.fromPartition(part)
        ses.setPreloads(ses.getPreloads().filter(p => p !== adblockerPreload))
    })
}
ipcMain.on("adblock-enable", (_, type) => {
    if (sessionList.length > 0) {
        // Only listen to enable calls after initial init has already happened
        enableAdblocker(type)
    }
})
ipcMain.on("adblock-disable", disableAdblocker)
const loadBlocklist = file => {
    const contents = readFile(file)
    if (contents) {
        return `${contents}\n`
    }
    return ""
}

// Manage installed browser extensions
ipcMain.on("install-extension", (_, url, extension, extType) => {
    const zipLoc = joinPath(argDatafolder, "extensions", extension)
    if (isDir(`${zipLoc}/`)) {
        mainWindow.webContents.send("notify",
            `Extension already installed: ${extension}`)
        return
    }
    makeDir(`${zipLoc}/`)
    mainWindow.webContents.send("notify",
        `Installing ${extType} extension: ${extension}`)
    const request = net.request({"partition": "persist:main", url})
    request.on("response", res => {
        const data = []
        res.on("end", () => {
            if (res.statusCode !== 200) {
                mainWindow.webContents.send("notify",
                    `Failed to install extension due to network error`, "err")
                console.warn(res)
                return
            }
            const file = Buffer.concat(data)
            writeFile(`${zipLoc}.${extType}`, file)
            extractZip([
                "x", "-aoa", "-tzip", `${zipLoc}.${extType}`, `-o${zipLoc}/`
            ], () => {
                rimraf(`${zipLoc}/_metadata/`)
                sessionList.forEach(ses => {
                    session.fromPartition(ses).loadExtension(zipLoc, {
                        "allowFileAccess": true
                    }).then(() => {
                        if (sessionList.indexOf(ses) === 0) {
                            mainWindow.webContents.send("notify",
                                `Extension successfully installed`, "suc")
                        }
                    }).catch(e => {
                        if (sessionList.indexOf(ses) === 0) {
                            mainWindow.webContents.send("notify",
                                `Failed to install extension, unsupported type`,
                                "err")
                            console.warn(e)
                            rimraf(`${zipLoc}*`)
                        }
                    })
                })
            })
        })
        res.on("data", chunk => {
            data.push(Buffer.from(chunk, "binary"))
        })
    })
    request.on("abort", e => {
        mainWindow.webContents.send("notify",
            `Failed to install extension due to network error`, "err")
        console.warn(e)
        rimraf(`${zipLoc}*`)
    })
    request.on("error", e => {
        mainWindow.webContents.send("notify",
            `Failed to install extension due to network error`, "err")
        console.warn(e)
        rimraf(`${zipLoc}*`)
    })
    request.end()
})
ipcMain.on("list-extensions", e => {
    e.returnValue = session.fromPartition("persist:main").getAllExtensions()
        .map(ex => ({
            "icon": ex.manifest.icons?.[Object.keys(ex.manifest.icons).pop()],
            "id": ex.id,
            "name": ex.name,
            "path": ex.path,
            "version": ex.version
        }))
})
ipcMain.on("remove-extension", (_, extensionId) => {
    const extLoc = joinPath(argDatafolder, `extensions/${extensionId}`)
    const extension = session.fromPartition("persist:main").getAllExtensions()
        .find(ext => ext.path.replace(/(\/|\\)$/g, "").endsWith(extensionId))
    if (isDir(`${extLoc}/`) && extension) {
        mainWindow.webContents.send("notify",
            `Removing extension: ${extensionId}`)
        sessionList.forEach(ses => {
            session.fromPartition(ses).removeExtension(extension.id)
        })
        rimraf(`${extLoc}*`)
        mainWindow.webContents.send("notify",
            `Extension successfully removed`, "suc")
    } else {
        mainWindow.webContents.send("notify", "Could not find extension with "
            + `id: ${extensionId}`, "warn")
    }
})

// Download favicons for websites
ipcMain.on("download-favicon", (_, options) => {
    const request = net.request({
        "session": webContents.fromId(options.webId).session, "url": options.fav
    })
    request.on("response", res => {
        const data = []
        res.on("end", () => {
            if (res.statusCode !== 200) {
                // Failed to download favicon
                return
            }
            const file = Buffer.concat(data)
            if (isSvg(file)) {
                writeFile(`${options.location}.svg`, file)
                mainWindow.webContents.send("favicon-downloaded",
                    options.linkId, options.url, `${options.fav}.svg`)
            } else {
                writeFile(options.location, file)
                mainWindow.webContents.send("favicon-downloaded",
                    options.linkId, options.url, options.fav)
            }
        })
        res.on("data", chunk => {
            data.push(Buffer.from(chunk, "binary"))
        })
    })
    request.on("abort", () => {
        // Failed to download favicon
    })
    request.on("error", () => {
        // Failed to download favicon
    })
    request.end()
})

// Window state save and restore
const windowStateFile = joinPath(app.getPath("appData"), "windowstate")
ipcMain.on("window-state-init", (_, restorePos, restoreSize, restoreMax) => {
    const bounds = {}
    const parsed = readJSON(windowStateFile)
    if (parsed) {
        bounds.x = Number(parsed.x)
        bounds.y = Number(parsed.y)
        bounds.width = Number(parsed.width)
        bounds.height = Number(parsed.height)
        bounds.maximized = !!parsed.maximized
    }
    if (restorePos) {
        if (bounds.x > 0 && bounds.y > 0) {
            mainWindow.setPosition(bounds.x, bounds.y)
        }
    }
    if (restoreSize) {
        if (bounds.width > 500 && bounds.height > 500) {
            mainWindow.setSize(bounds.width, bounds.height)
        }
    }
    if (bounds.maximized && restoreMax) {
        mainWindow.maximize()
    }
    mainWindow.show()
    mainWindow.focus()
    // Save the window state when resizing or maximizing.
    // Move and resize state are saved and checked to detect window snapping.
    let justMoved = false
    let justResized = false
    mainWindow.on("maximize", saveWindowState)
    mainWindow.on("unmaximize", saveWindowState)
    mainWindow.on("resize", () => {
        justResized = true
        setTimeout(() => {
            if (!justMoved) {
                saveWindowState()
            }
        }, 10)
        setTimeout(() => {
            justResized = false
        }, 30)
    })
    mainWindow.on("move", () => {
        justMoved = true
        setTimeout(() => {
            if (!justResized) {
                saveWindowState()
            }
        }, 10)
        setTimeout(() => {
            justMoved = false
        }, 30)
    })
})
const saveWindowState = (maximizeOnly = false) => {
    let state = readJSON(windowStateFile) || {}
    if (!maximizeOnly && !mainWindow.isMaximized()) {
        const newBounds = mainWindow.getBounds()
        const currentScreen = screen.getDisplayMatching(newBounds).bounds
        const sameW = newBounds.width === currentScreen.width
        const sameH = newBounds.height === currentScreen.height
        const halfW = newBounds.width === currentScreen.width / 2
        const halfH = newBounds.height === currentScreen.height / 2
        const halfX = newBounds.x === currentScreen.x / 2
        const halfY = newBounds.y === currentScreen.y / 2
        if (!sameW && !sameH && !halfW && !halfH && !halfX && !halfY) {
            state = newBounds
        }
    }
    state.maximized = mainWindow.isMaximized()
    writeJSON(windowStateFile, state)
}

// Miscellaneous tasks
ipcMain.on("disable-localrtc", (_, id) => {
    webContents.fromId(id).setWebRTCIPHandlingPolicy(
        "default_public_interface_only")
})
ipcMain.handle("save-page", (_, id, loc) => {
    webContents.fromId(id).savePage(loc, "HTMLComplete")
})
ipcMain.on("hide-window", () => {
    if (!argDebugMode) {
        mainWindow.hide()
    }
})
ipcMain.on("add-devtools", (_, pageId, devtoolsId) => {
    const page = webContents.fromId(pageId)
    const devtools = webContents.fromId(devtoolsId)
    page.setDevToolsWebContents(devtools)
    page.openDevTools()
    devtools.executeJavaScript("window.location.reload()")
})
ipcMain.on("open-internal-devtools",
    () => mainWindow.webContents.openDevTools({"mode": "undocked"}))
ipcMain.on("destroy-window", () => {
    cancellAllDownloads()
    mainWindow.destroy()
})
ipcMain.handle("list-spelllangs",
    () => session.defaultSession.availableSpellCheckerLanguages)
ipcMain.handle("toggle-fullscreen", () => {
    mainWindow.fullScreen = !mainWindow.fullScreen
})
let blockedInsertMappings = []
ipcMain.on("insert-mode-blockers", (e, blockedMappings) => {
    blockedInsertMappings = blockedMappings
    e.returnValue = null
})
const currentInputMatches = input => blockedInsertMappings.find(mapping => {
    if (!!mapping.alt === input.alt && !!mapping.control === input.control) {
        if (!!mapping.meta === input.meta && !!mapping.shift === input.shift) {
            return mapping.key === input.key
        }
    }
    return false
})
ipcMain.on("insert-mode-listener", (_, id) => {
    webContents.fromId(id).on("before-input-event", (e, input) => {
        if (blockedInsertMappings === "pass") {
            return
        }
        if (blockedInsertMappings === "all") {
            e.preventDefault()
        } else if (currentInputMatches(input)) {
            e.preventDefault()
        }
        mainWindow.webContents.send("insert-mode-input-event", input)
    })
})
ipcMain.on("set-window-title", (_, title) => {
    mainWindow.title = title
})
ipcMain.handle("show-message-dialog", (_, options) => dialog.showMessageBox(
    mainWindow, options))
ipcMain.handle("list-cookies", e => e.sender.session.cookies.get({}))
ipcMain.handle("remove-cookie",
    (e, url, name) => e.sender.session.cookies.remove(url, name))
ipcMain.handle("make-default-app", () => {
    app.setAsDefaultProtocolClient("http")
    app.setAsDefaultProtocolClient("https")
})
// Operations below are sync
ipcMain.on("override-global-useragent", (e, globalUseragent) => {
    app.userAgentFallback = globalUseragent || useragent()
    e.returnValue = null
})
ipcMain.on("rimraf", (e, folder) => {
    e.returnValue = rimraf(folder)
})
ipcMain.on("app-config-settings", e => {
    e.returnValue = {"order": argConfigOrder, "override": argConfigOverride}
})
ipcMain.on("app-version", e => {
    e.returnValue = version
})
ipcMain.on("appdata-path", e => {
    e.returnValue = app.getPath("appData")
})
ipcMain.on("custom-icon", e => {
    e.returnValue = customIcon || undefined
})
ipcMain.on("app-name", e => {
    e.returnValue = app.getName()
})
ipcMain.on("is-fullscreen", e => {
    e.returnValue = mainWindow.fullScreen
})
ipcMain.on("relaunch", () => app.relaunch())
