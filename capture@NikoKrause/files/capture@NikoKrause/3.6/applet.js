/**
 * Cinnamon Desktop Capture applet.
 *
 * @author  Rob Adams <pillage@gmail.com>
 * @link    http://github.com/rjanja/desktop-capture/
 */


const Cinnamon = imports.gi.Cinnamon;
const Applet = imports.ui.applet;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const PopupMenu = imports.ui.popupMenu;
const PopupSliderMenuItem = imports.ui.popupMenu.PopupSliderMenuItem;
const PopupSwitchMenuItem = imports.ui.popupMenu.PopupSwitchMenuItem;
const PopupBaseMenuItem = imports.ui.popupMenu.PopupBaseMenuItem;
const Switch = imports.ui.popupMenu.Switch;
const Clutter = imports.gi.Clutter;
const Lightbox = imports.ui.lightbox;
const Settings = imports.ui.settings;
const MessageTray = imports.ui.messageTray;
const Signals = imports.signals;

const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const St = imports.gi.St;
const Gtk = imports.gi.Gtk;

const KEY_RECORDER_SCHEMA = "org.cinnamon.recorder";
const KEY_RECORDER_FRAMERATE = "framerate";
const KEY_RECORDER_FILE_EXTENSION = "file-extension";
const KEY_RECORDER_PIPELINE = "pipeline";

const ClipboardCopyType = {
    OFF: 0,
    DEFAULT: 1,
    PATH: 1,
    DIRECTORY: 2,
    FILENAME: 3,
    IMAGEDATA: 4
}

// Globals we'll set once we have metadata in main()
let Screenshot;
let AppUtil;
let AppletDir;
let SETTINGS_FILE;
let ICON_FILE;
let ICON_FILE_ACTIVE;
let CLIPBOARD_HELPER;

// We use an altered URLHighlighter because /tmp looks better than file://tmp/,
// and I'm a picky SOB.
function URLHighlighter(text, lineWrap, allowMarkup) {
    this._init(text, lineWrap, allowMarkup);
}
URLHighlighter.prototype = {
    __proto__: MessageTray.URLHighlighter.prototype,

    _init: function(text, lineWrap, allowMarkup) {
        MessageTray.URLHighlighter.prototype._init.call(this, text, lineWrap, allowMarkup);
    },

    // _shortenUrl doesn't exist in base class
    _shortenUrl: function(url) {
        if (url.substring(0, 7) == 'http://') {
            return url.substring(7);
        } else if (url.substring(0, 7) == 'file://') {
            return url.substring(7);
        }
        return url;
    },

    _highlightUrls: function() {
        // text here contain markup
        let urls = Util.findUrls(this._text);
        let markup = '';
        let pos = 0;
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            let str = this._text.substr(pos, url.pos - pos);
            let shortUrl = this._shortenUrl(url.url);

            markup += str + '<span foreground="' + this._linkColor + '"><u>' + shortUrl + '</u></span>';
            pos = url.pos + url.url.length;

            if (shortUrl != url.url) {
                // Save the altered match position
                this._urls[i].pos -= url.url.length - shortUrl.length;
            }
        }
        markup += this._text.substr(pos);
        this.actor.clutter_text.set_markup(markup);
    },
}

function Source(sourceId, screenshot) {
    this._init(sourceId, screenshot);
}

Source.prototype = {
    ICON_SIZE: 24,

    __proto__: MessageTray.Source.prototype,

    _init: function(sourceId, screenshot) {
        MessageTray.Source.prototype._init.call(this, sourceId);
        this.setTransient(false);
    },

    createNotificationIcon: function() {
        let icon_file = Gio.file_new_for_path('camera-photo-symbolic');
        let icon_uri = icon_file.get_uri();
        return St.TextureCache.get_default().load_uri_async(icon_uri, this.ICON_SIZE, this.ICON_SIZE);
    },

    _lastNotificationRemoved: function() {
        this.destroy();
    }
}

function TimerSlider() {
    this._init.apply(this, arguments);
}
TimerSlider.prototype = {
    __proto__: PopupMenu.PopupBaseMenuItem.prototype,

    _init: function(defaultVal, min, max, round, params) {
        PopupMenu.PopupBaseMenuItem.prototype._init.call(this, params);

        /* set up properties */
        this.min = min || 0;
        this.max = max || 1;
        this.round = round || false;
        this._value = defaultVal;
        if (round) {
            this._value = Math.round(this._value);
        }

        /* set up item */
        this.box = new St.BoxLayout({
            style_class: 'timer-slider',
            vertical: true
        });
        this.addActor(this.box, {
            expand: true,
            span: -1
        });

        this.iconName = 'alarm-symbolic';
        this.icon = new St.Icon({
            icon_name: this.iconName,
            icon_type: St.IconType.SYMBOLIC,
            icon_size: 16
        });

        this.topBox = new St.BoxLayout({
            vertical: false,
            style_class: 'slider-menu-item-top-box'
        });
        this.box.add(this.topBox, {
            x_fill: true
        });

        this.bottomBox = new St.BoxLayout({
            vertical: false,
            style_class: 'slider-menu-item-bottom-box'
        });
        this.box.add(this.bottomBox, {
            x_fill: true
        });

        /* text */
        this.label = new St.Label({
            text: _("Capture delay"),
            style_class: 'timer-slider-label'
        });

        /* number */
        this.valueLabel = new St.Label({
            text: '',
            style_class: 'menuitem-detail',
            reactive: false
        });
        this._setLabelValue(defaultVal);

        /* slider */
        this.slider = new PopupMenu.PopupSliderMenuItem((defaultVal - min) /
            (max - min)); // between 0 and 1

        this.slider.connect('value-changed', Lang.bind(this, this._updateValue));
        this.slider.connect('drag-end', Lang.bind(this, function() {
            this.emit('drag-end', this._value);
        }));

        this.labelBox = new St.BoxLayout({
            vertical: false,
            style_class: 'timer-slider-menu-item-label-box'
        });
        this.labelBox.add(this.icon);
        this.labelBox.add(this.label);
        this.topBox.add(this.labelBox, {
            expand: true
        });

        this.topBox.add(this.valueLabel, {
            align: St.Align.END
        });
        this.bottomBox.add(this.slider.actor, {
            expand: true,
            span: -1
        });
    },

    /* returns the value of the slider, either the raw (0-1) value or the
     * value on the min->max scale. */
    getValue: function(raw) {
        if (raw) {
            return this.slider.value;
        } else {
            return this._value;
        }
    },
    /* sets the value of the slider, either the raw (0-1) value or the
     * value on the min->max scale */
    setValue: function(value, raw) {
        value = (raw ? value : (value - this.min) / (this.max - this.min));
        this._updateValue(this.slider, value);
        this.slider.setValue(value);
    },
    _updateValue: function(slider, value) {
        let val = value * (this.max - this.min) + this.min;
        if (this.round) {
            val = Math.round(val);
        }
        this._value = val;
        this._setLabelValue(val);
    },
    _setLabelValue: function(value) {
        if (value == 0) {
            this.valueLabel.set_text(_('Off'));
        } else {
            this.valueLabel.set_text(Gettext.dngettext(UUID, "%d second", "%d seconds", value).format(value));
        }
    }
};

function ScreenshotNotification(source, title, banner, params) {
    this._init(source, title, banner, params);
}
ScreenshotNotification.prototype = {
    __proto__: MessageTray.Notification.prototype,
    _delayedResident: null,
    _cursorChanged: false,

    _init: function(source, title, banner, params) {
        MessageTray.Notification.prototype._init.call(this, source, title, banner, params);
    },

    // We override setImage so we can change row_span from 2->1.
    setImage: function(image) {
        if (this._imageBin)
            this.unsetImage();

        // Make our bin reactive so we can click on it
        this._imageBin = new St.Bin({
            reactive: true,
            style_class: 'screenshot-thumbnail'
        });
        this._imageBin.child = image;
        this._imageBin.opacity = 230;

        this._table.add_style_class_name('multi-line-notification');
        this._table.add_style_class_name('notification-with-image');
        this._addBannerBody();
        this._updateLastColumnSettings();
        this._table.add(this._imageBin, {
            row: 1,
            col: 1,
            row_span: 2,
            x_expand: false,
            y_expand: false,
            x_fill: false,
            y_fill: false
        });

        // Make the image thumbnail interactive
        this._imageBin.connect('button-press-event', Lang.bind(this, this._onImageButtonPressed));
        this._imageBin.connect('motion-event', Lang.bind(this, function(actor, event) {
            if (!actor.visible || actor.get_paint_opacity() == 0)
                return false;

            global.set_cursor(Cinnamon.Cursor.POINTING_HAND);
            this._cursorChanged = true;
            this._imageBin.add_style_class_name('screenshot-thumbnail-hover');
            return false;
        }));
        this._imageBin.connect('leave-event', Lang.bind(this, function() {
            if (!this._imageBin.visible || this._imageBin.get_paint_opacity() == 0)
                return;

            if (this._cursorChanged) {
                this._cursorChanged = false;
                global.unset_cursor();
                this._imageBin.remove_style_class_name('screenshot-thumbnail-hover');
            }
        }));
    },

    _onImageMouseover: function(actor, event) {
        //global.log('mouseover!!');
    },

    // Expose the clicks now and maybe we'll allow configurable behavior later
    _onImageButtonPressed: function(actor, event) {
        if (event.get_button() == 1) {
            this.emit('image-left-clicked');
            return true;
        } else if (event.get_button() == 3) {
            this.emit('image-right-clicked');
        } else if (event.get_button() == 2) {
            this.emit('image-middle-clicked');
        }

        return false;
    },

    // Similarly we need to change the action area to spn both columns.
    _updateLastColumnSettings: function() {
        if (this._scrollArea)
            this._table.child_set(this._scrollArea, {
                col: 2,
                col_span: 1
            });
        if (this._actionArea)
            this._table.child_set(this._actionArea, {
                row: 3,
                col: 1,
                row_span: 1,
                col_span: 2,
                x_fill: false,
                x_expand: false
            });
    },

    _onClicked: function() {
        this.emit('clicked');
    },

    addBody: function(text, markup, style) {
        if (this.bodyLabel) {
            this.bodyLabel.actor.destroy();
            this.bodyLabel = null;
        }

        this.bodyLabel = new URLHighlighter(text, true, markup);
        this.addActor(this.bodyLabel.actor, style);
        return this.bodyLabel.actor;
    },
}


function StubbornSwitchMenuItem() {
    this._init.apply(this, arguments);
}

StubbornSwitchMenuItem.prototype = {
    __proto__: PopupSwitchMenuItem.prototype,

    activate: function(event) {
        if (this._switch.actor.mapped) {
            this.toggle();
        }

        // we allow pressing space to toggle the switch
        // without closing the menu
        if (event.type() == Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() == Clutter.KEY_space)
            return;
    },
};

function getSettings(schema) {
    try {
        if (Gio.Settings.list_schemas().indexOf(schema) == -1)
            throw _("Schema \"%s\" not found.").format(schema);
        return new Gio.Settings({
            schema: schema
        });
    } catch (e) {
        return null;
    }
}

function LocalSettings(uuid, instanceId) {
    this._init(uuid, instanceId);
}
LocalSettings.prototype = {
    _init: function(uuid, instanceId) {
        this._initialized = false;
        this._localSettings = false;
        this._filename = SETTINGS_FILE = AppletDir + '/settings.json';;
        this._settingsFile = Gio.file_new_for_path(this._filename);
        this._settings = this._oldSettings = {};
        this._monitor = this._settingsFile.monitor(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', Lang.bind(this, this._settingsChanged));
        this._settingsChanged();
        this._initialized = true;
    },

    _settingsChanged: function(monitor, fileObj, n, eventType) {
        if (eventType !== undefined && eventType != Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
            return true;
        }

        try {
            let file = Gio.File.new_for_path(this._filename);
            let [status, buffer] = file.load_contents(null);
            this._settings = JSON.parse(buffer);
            this.emit("settings-changed");
            if (this._initialized) {
                for (var k in this._settings) {
                    if (this._settings[k] !== this._oldSettings[k]) {
                        //global.log('emitting changed::'+k);
                        this.emit("changed::" + k, k, this._oldSettings[k], this._settings[k]);
                    }
                }
            }
            this._oldSettings = this._settings;
        } catch (e) {
            global.logError("Could not parse " + this._filename);
            global.logError(e);
        }
        return true;
    },

    getValue: function(settings_key) {
        return this._settings[settings_key];
    },

    setValue: function(settings_key, value) {
        this._settings[settings_key] = value;
        this.writeSettings();
    },

    writeSettings: function() {
        let filedata = JSON.stringify(this._settings, null, "   ");
        GLib.file_set_contents(this._filename, filedata, filedata.length);
    }
};
Signals.addSignalMethods(LocalSettings.prototype);

function MyAppletPopupMenu(launcher, orientation, animateClose) {
    this._init(launcher, orientation, animateClose);
}

MyAppletPopupMenu.prototype = {
    __proto__: Applet.AppletPopupMenu.prototype,

    _init: function(launcher, orientation, animateClose) {
        Applet.AppletPopupMenu.prototype._init.call(this, launcher, orientation);
        this._animateClose = animateClose;
    },

    addAction: function(title, callback, detail_text) {
        let menuItem = Applet.AppletPopupMenu.prototype.addAction.call(this, title, callback);

        if (detail_text) {
            let bin = new St.Bin({
                x_align: St.Align.END,
                style_class: 'menuitem-detail'
            });
            let label = new St.Label();
            label.set_text(detail_text);
            bin.add_actor(label);
            menuItem.addActor(bin, {
                expand: true,
                span: -1,
                align: St.Align.END
            });
        }

        return menuItem;
    }
}

// l10n/translation
const Gettext = imports.gettext;
let UUID;

function _(str) {
    let customTranslation = Gettext.dgettext(UUID, str);
    if (customTranslation != str) {
        return customTranslation;
    }
    return Gettext.gettext(str);
};

function MyApplet(metadata, orientation, panelHeight, instanceId) {
    this._init(metadata, orientation, panelHeight, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _notificationImageSize: 128,
    _notificationIconSize: 24,
    _uuid: null,

    log: function(msg) {
        //return;
        if (typeof msg == 'object') {
            global.log(msg);
        } else {
            global.log('capture@NikoKrause: ' + msg);
        }

    },

    _initSettings: function() {
        try {
            this.settings = new Settings.AppletSettings(this, this._uuid, this._instanceId);
            this.log('Using AppletSettings');
            this._localSettings = false;
        } catch (e) {
            this.log('Falling back to LocalSettings');
            this.settings = new LocalSettings(this._uuid, this._instanceId);
            this._localSettings = true;
        }

        this.settings.connect("settings-changed", Lang.bind(this, this._onSettingsChanged));
        this.settings.connect("changed::use-symbolic-icon", Lang.bind(this, this._onRuntimeChanged));
        this.settings.connect("changed::show-copy-toggle", Lang.bind(this, this._onRuntimeChanged));

        this._onSettingsChanged();
    },

    _onKeybindingChanged: function(provider, key, oldVal, newVal) {
        Main.keybindingManager.addHotKey(key, newVal, Lang.bind(this, function(e) {
            return this._bindFns[key]();
        }));
    },

    registerKeyBinding: function(key, captureType, index) {
        this._bindFns[key] = Lang.bind(this, function() {
            if (captureType == 'RECORDER') {
                return this._toggle_cinnamon_recorder();
            } else if (captureType == Screenshot.SelectionType.REPEAT) {
                return this.repeat_cinnamon_camera();
            } else {
                return this.run_cinnamon_camera(captureType, null, index);
            }
        });

        // Read current value and if set, add the hotkey
        var curVal = this.settings.getValue(key);
        if (curVal != '' && curVal != null) {
            this._onKeybindingChanged(null, key, null, curVal);
        }

        // Rebind with any future changes
        this.settings.connect("changed::" + key, Lang.bind(this, this._onKeybindingChanged));
    },

    _registerKeyBindings: function() {
        if (this._localSettings) return;

        this.registerKeyBinding('kb-cs-screen', Screenshot.SelectionType.SCREEN);
        this.registerKeyBinding('kb-cs-window', Screenshot.SelectionType.WINDOW);
        this.registerKeyBinding('kb-cs-area', Screenshot.SelectionType.AREA);
        this.registerKeyBinding('kb-cs-ui', Screenshot.SelectionType.CINNAMON);
        this.registerKeyBinding('kb-cs-repeat', Screenshot.SelectionType.REPEAT);

        if (Main.layoutManager.monitors.length > 1) {
            Main.layoutManager.monitors.forEach(Lang.bind(this, function(monitor, index) {
                // we only support three monitors w/ shortcuts due to lack of conditional settings
                // in cinnamon xlet settings. see also issue 71
                if (index < 3) {
                    this.registerKeyBinding('kb-cs-monitor-' + index, Screenshot.SelectionType.MONITOR, index);
                }
            }));
        }

        this.registerKeyBinding('kb-recorder-stop', 'RECORDER');
    },

    _onSettingsChanged: function(evt, type) {
        this._includeCursor = this.settings.getValue('include-cursor');
        this._openAfter = this.settings.getValue('open-after');
        this._delay = this.settings.getValue('delay-seconds');
        this._cameraSaveDir = this.settings.getValue('camera-save-dir');
        this._recorderSaveDir = this.settings.getValue('recorder-save-dir');

        // Allow save locations to begin with a tilde.
        this.parseSaveFolder('_cameraSaveDir', 'camera-save-dir', GLib.UserDirectory.DIRECTORY_PICTURES);
        this.parseSaveFolder('_recorderSaveDir', 'recorder-save-dir', GLib.UserDirectory.DIRECTORY_VIDEOS);

        this._cameraSavePrefix = this.settings.getValue('camera-save-prefix');
        this._recorderSavePrefix = this.settings.getValue('recorder-save-prefix');
        this._windowAsArea = this.settings.getValue('capture-window-as-area');
        this._includeWindowFrame = this.settings.getValue('include-window-frame');
        this._useCameraFlash = this.settings.getValue('use-camera-flash');
        this._playShutterSound = this.settings.getValue('play-shutter-sound');
        this._playIntervalSound = this.settings.getValue('play-timer-interval-sound');
        this._copyToClipboard = this.settings.getValue('copy-to-clipboard');
        this._copyData = this.settings.getValue('copy-data');
        this._showCopyToggle = this.settings.getValue('show-copy-toggle');
        this._copyDataAutoOff = this.settings.getValue('copy-data-auto-off');
        this._sendNotification = this.settings.getValue('send-notification');
        this._includeStyles = this.settings.getValue('include-styles');

        this._showDeleteAction = this.settings.getValue('show-delete-action');
        this._showCopyPathAction = this.settings.getValue('show-copy-path-action');
        this._showCopyDataAction = this.settings.getValue('show-copy-data-action');

        if (this._shouldRedraw) {
            this.draw_menu();
            this._shouldRedraw = false;
        } else {
            if (this.timerSlider) {
                this.timerSlider.setValue(this._delay);
            }
        }

        return false;
    },

    parseSaveFolder: function(oper_key, settings_key, special_default) {
        this[oper_key] = this.settings.getValue(settings_key);
        let initial_setting = this[oper_key];

        // use special folder as default e.g. Pictures
        if (this[oper_key] == "" || this[oper_key] === null) {
            this[oper_key] = GLib.get_user_special_dir(special_default);
        } else {
            this[oper_key] = this[oper_key].replace("//", "/");
        }

        // expand any tildes
        if (this[oper_key].charAt(0) == '~') {
            let input = this[oper_key].slice(1);
            this[oper_key] = GLib.get_home_dir() + '/' + input;
        }

        // handle file prefix
        if (this[oper_key].indexOf("file:///") === 0) {
            this[oper_key] = this[oper_key].replace("file:///", "/");
        } else if (this[oper_key].indexOf("file://") === 0) {
            this[oper_key] = this[oper_key].replace("file://", "/");
        }

        if (false == this._getCreateFolder(this[oper_key], false)) {
            this[oper_key] = GLib.get_user_special_dir(special_default);
        }

        // write back to settings
        if (this[oper_key] != initial_setting) {
            this.settings.setValue(settings_key, this[oper_key]);
        }
    },

    getSettingValue: function(key) {
        return this.settings.getValue(key);
    },

    setSettingValue: function(key, value) {
        return this.settings.setValue(key, value);
    },

    getModifier: function(symbol) {
        return this._modifiers[symbol] || false;
    },

    setModifier: function(symbol, value) {
        this._modifiers[symbol] = value;
    },

    _onMenuKeyRelease: function(actor, event) {
        let symbol = event.get_key_symbol();

        if (symbol == Clutter.Shift_L) {
            this.setModifier(symbol, false);
        }

        return false;
    },

    _onMenuKeyPress: function(actor, event) {
        let symbol = event.get_key_symbol();

        if (symbol == Clutter.Shift_L) {
            this.setModifier(symbol, true);
        }

        return false;
    },

    _onRuntimeChanged: function(settingsObj, key, oldVal, newVal) {
        this._shouldRedraw = true;
    },

    _crSettingsChanged: function(settings, key) {
        this.cRecorder = new Cinnamon.Recorder({
            stage: global.stage
        });
        this._crFrameRate = this._crSettings.get_int(KEY_RECORDER_FRAMERATE);
        this._crFileExtension = this._crSettings.get_string(KEY_RECORDER_FILE_EXTENSION);
        this._crPipeline = this._crSettings.get_string(KEY_RECORDER_PIPELINE);
        return false;
    },

    _init: function(metadata, orientation, panelHeight, instanceId) {
        Applet.IconApplet.prototype._init.call(this, orientation, panelHeight, instanceId);

        try {
            this._programs = {};
            this._bindFns = {};
            this._includeCursor = false;
            this._openAfter = false;
            this._delay = 0;
            this._copyData = false;
            this._showCopyToggle = true;
            this._copyDataAutoOff = true;
            this.orientation = orientation;
            this.cRecorder = null;
            this._crFrameRate = null;
            this._crFileExtension = null;
            this._crPipeline = null;
            this._redoMenuItem = null;
            this.lastCapture = null;
            this._instanceId = instanceId;
            this._uuid = metadata.uuid;
            this._shouldRedraw = false;
            this._canOpenFolderFile = false;
            this._fileman = null;

            // l10n/translation
            UUID = metadata.uuid;
            Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

            this.maybeRegisterRole("screenshot", metadata.uuid);

            this.testCanOpenFolderFile();

            // Load up our settings
            this._initSettings();

            // Cinnamon Recorder settings
            this._crSettings = getSettings(KEY_RECORDER_SCHEMA);
            this._crSettings.connect('changed', Lang.bind(this, this._crSettingsChanged));
            this._crSettingsChanged();

            this._registerKeyBindings();

            let xfixesCursor = Cinnamon.XFixesCursor.get_for_stage(global.stage);
            this._xfixesCursor = xfixesCursor;

            this.actor.add_style_class_name('desktop-capture');

            this.set_applet_tooltip(_("Screenshot and desktop video"));

            this.draw_menu(orientation);

            // When monitors are connected or disconnected, redraw the menu
            Main.layoutManager.connect('monitors-changed', Lang.bind(this, this.draw_menu));

            // Add the right-click context menu item. This only needs
            // to be drawn a single time.
            if (this._localSettings) {
                this.settingsItem = new Applet.MenuItem(_("Capture settings"),
                    'system-run', Lang.bind(this, this._launch_settings));

                this._applet_context_menu.addMenuItem(this.settingsItem);
            }
        } catch (e) {
            global.logError(e);
        }
    },

    _checkPaths: function(force) {
        force = force || false;

        this._cameraTitle.setSensitive(
            false != this._getCreateFolder(this._cameraSaveDir, force));

        this._recorderTitle.setSensitive(
            false != this._getCreateFolder(this._recorderSaveDir, force));
    },

    _doRunHandler: function(uri, context) {
        try {
            Gio.app_info_launch_default_for_uri(uri,
                this._getLaunchContext(context));
        } catch (e) {
            global.log('Spawning xdg-open ' + uri);
            Util.spawn(['xdg-open', uri]);
        }
    },

    _openScreenshotsFolder: function() {
        this._checkPaths(true);
        this._doRunHandler('file://' + this._cameraSaveDir);
    },

    _openRecordingsFolder: function() {
        this._checkPaths(true);
        this._doRunHandler('file://' + this._recorderSaveDir);
    },

    /**
     * showSystemCursor:
     * Show the system mouse pointer.
     */
    showSystemCursor: function() {
        this._xfixesCursor.show();
    },

    /**
     * hideSystemCursor:
     * Hide the system mouse pointer.
     */
    hideSystemCursor: function() {
        this._xfixesCursor.hide();
    },

    indent: function(text) {
        return text;
    },

    draw_menu: function(orientation) {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new MyAppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        this._contentSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._contentSection);

        this.set_applet_icon_symbolic_name('camera-photo-symbolic');

        this._cameraTitle = new PopupMenu.PopupIconMenuItem(
            _("Camera") + ": " + _("Built-in"), 'folder-pictures', St.IconType.SYMBOLIC);
        this._cameraTitle.connect('activate', Lang.bind(this, this._openScreenshotsFolder));

        this.menu.addMenuItem(this._cameraTitle);

        this.menu.addAction(this.indent(_("Screen")), Lang.bind(this, function(e) {
            return this.run_cinnamon_camera(Screenshot.SelectionType.SCREEN, e);
        }), this.settings.getValue('kb-cs-screen'));
        this.menu.addAction(this.indent(_("Window")), Lang.bind(this, function(e) {
            return this.run_cinnamon_camera(Screenshot.SelectionType.WINDOW, e);
        }), this.settings.getValue('kb-cs-window'));
        this.menu.addAction(this.indent(_("Area")), Lang.bind(this, function(e) {
            return this.run_cinnamon_camera(Screenshot.SelectionType.AREA, e);
        }), this.settings.getValue('kb-cs-area'));
        this.menu.addAction(this.indent(_("Cinnamon UI")), Lang.bind(this, function(e) {
            return this.run_cinnamon_camera(Screenshot.SelectionType.CINNAMON, e);
        }), this.settings.getValue('kb-cs-ui'));

        if (Main.layoutManager.monitors.length > 1) {
            Main.layoutManager.monitors.forEach(function(monitor, index) {
                if (index < 3) {
                    this.menu.addAction(this.indent(_("Monitor %d").format(index + 1)),
                        Lang.bind(this, function(e) {
                            return this.run_cinnamon_camera(Screenshot.SelectionType.MONITOR, e, index);
                        }), 'kb-cs-monitor-' + index);
                }
            }, this);
        }

        this._redoMenuItem = this.menu.addAction(
            this.indent(_("Repeat last")),
            Lang.bind(this, this.repeat_cinnamon_camera),
            this.settings.getValue('kb-cs-repeat'));

        if (this.lastCapture === null) {
            this._redoMenuItem.actor.hide();
        }

        // OPTION: Include Cursor (toggle switch)
        let optionSwitch = new PopupSwitchMenuItem(this.indent(_("Include cursor")), this._includeCursor, {
            style_class: 'bin'
        });
        optionSwitch.connect('toggled', Lang.bind(this, function(e1, v) {
            this._includeCursor = v;
            this.setSettingValue('include-cursor', v);

            return false;
        }));
        this.menu.addMenuItem(optionSwitch);

        this.timerSlider = new TimerSlider(this._delay, 0, 10, {
            reactive: false
        });
        this.timerSlider.connect("drag-end", Lang.bind(this, function(slider, val) {
            this._delay = val;
            this.settings.setValue('delay-seconds', val);
        }));
        this.menu.addMenuItem(this.timerSlider);


        if (this._showCopyToggle) {
            let copyDataSwitch = new StubbornSwitchMenuItem(this.indent(_("Copy image")), this._copyData, {
                style_class: 'bin'
            });
            copyDataSwitch.connect('toggled', Lang.bind(this, function(e1, v) {
                this._copyData = v;
                this.setSettingValue('copy-data', v);
                return false;
            }));
            this.menu.addMenuItem(copyDataSwitch);
        } else {
            // Turn off our hidden setting since the UI can't.
            this._copyData = false;
            this.setSettingValue('copy-data', false);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._recorderTitle = new PopupMenu.PopupIconMenuItem(
            _("Recorder") + ": " + _("Built-in"), "folder-videos", St.IconType.SYMBOLIC);
        this._recorderTitle.connect('activate', Lang.bind(this, this._openRecordingsFolder));

        this.menu.addMenuItem(this._recorderTitle);

        this._cRecorderItem = this.menu.addAction(
            this.indent(_("Start recording")),
            Lang.bind(this, this._toggle_cinnamon_recorder),
            this.settings.getValue('kb-recorder-stop'));

        // Listen in for shift+clicks so we can alter our behavior accordingly.
        this.menu.actor.connect('key-press-event', Lang.bind(this, this._onMenuKeyPress));
        this.menu.actor.connect('key-release-event', Lang.bind(this, this._onMenuKeyRelease));
    },

    get_camera_filename: function(type) {
        let date = new Date();
        let prefix = this._cameraSavePrefix;

        if (type == undefined) {
            prefix = prefix.replace('%TYPE_', '');
            prefix = prefix.replace('%TYPE-', '');
            prefix = prefix.replace('%TYPE', '');
        }
        return this.replaceTokens(
            ['%Y',
                '%M',
                '%D',
                '%H',
                '%I',
                '%S',
                '%m',
                '%TYPE'
            ], [date.getFullYear(),
                this._padNum(date.getMonth() + 1),
                this._padNum(date.getDate()),
                this._padNum(date.getHours()),
                this._padNum(date.getMinutes()),
                this._padNum(date.getSeconds()),
                this._padNum(date.getMilliseconds()),
                Screenshot.SelectionTypeStr[type]
            ],
            prefix);
    },

    get_recorder_filename: function(type) {
        let date = new Date();
        return this.replaceTokens(
            ['%Y',
                '%M',
                '%D',
                '%H',
                '%I',
                '%S',
                '%m',
            ], [date.getFullYear(),
                this._padNum(date.getMonth() + 1),
                this._padNum(date.getDate()),
                this._padNum(date.getHours()),
                this._padNum(date.getMinutes()),
                this._padNum(date.getSeconds()),
                this._padNum(date.getMilliseconds())
            ],
            this._recorderSavePrefix);
    },

    _padNum: function(num) {
        return (num < 10 ? '0' + num : num);
    },

    repeat_cinnamon_camera: function(event) {
        if (this.lastCapture) {
            let filename;
            try {
                filename = this._getCreateFilePath(this._cameraSaveDir, this.get_camera_filename(this.lastCapture.selectionType), 'png');
            } catch (e) {
                filename = false;
                global.log(e);
            }

            if (false == filename) {
                return false;
            }

            this.lastCapture.options.filename = filename;

            this.maybeCloseMenu();
            let camera = new Screenshot.ScreenshotHelper(null, null, this.lastCapture.options);

            switch (this.lastCapture.selectionType) {
                case Screenshot.SelectionType.WINDOW:
                    camera.screenshotWindow(
                        this.lastCapture.window,
                        this.lastCapture.options);
                    break;
                case Screenshot.SelectionType.AREA:
                    camera.screenshotArea(
                        this.lastCapture.x,
                        this.lastCapture.y,
                        this.lastCapture.width,
                        this.lastCapture.height,
                        this.lastCapture.options);
                    break;
                case Screenshot.SelectionType.CINNAMON:
                    camera.screenshotCinnamon(
                        this.lastCapture.actor,
                        this.lastCapture.stageX,
                        this.lastCapture.stageY,
                        this.lastCapture.options);
                    break;
            }
        }

        return true;
    },

    cinnamon_camera_complete: function(screenshot) {
        screenshot.json = null;
        screenshot.extraActionMessage = '';

        this.lastCapture = screenshot;
        let copyToClipboard = this._copyData ? 4 : this._copyToClipboard;

        // We only support re-do of capture when we're using our own (for now)
        if (this.lastCapture.selectionType != Screenshot.SelectionType.SCREEN) {
            this._redoMenuItem.actor.show();
        } else {
            this._redoMenuItem.actor.hide();
        }
        if (this._copyData && this._copyDataAutoOff) {
            this._copyData = false;
            this.draw_menu();
        }

        if (this._copyToClipboard) {
            if (ClipboardCopyType.PATH == copyToClipboard) {
                this.setClipboardText(screenshot.file)
                screenshot.clipboardMessage = _('Path has been copied to clipboard.');
            } else if (ClipboardCopyType.FILENAME == copyToClipboard) {
                this.setClipboardText(screenshot.outputFilename);
                screenshot.clipboardMessage = _('Filename has been copied to clipboard.');
            } else if (ClipboardCopyType.DIRECTORY == copyToClipboard) {
                this.setClipboardText(screenshot.outputDirectory);
                screenshot.clipboardMessage = _('Directory has been copied to clipboard.');
            } else if (ClipboardCopyType.IMAGEDATA == copyToClipboard &&
                CLIPBOARD_HELPER) {
                AppUtil.Exec('python ' + CLIPBOARD_HELPER + ' ' + screenshot.file);
                screenshot.clipboardMessage = _('Image data has been copied to clipboard.');
            }
        }

        this.maybeSendNotification(screenshot);
    },

    setClipboardText: function(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    },

    maybeSendNotification: function(screenshot) {
        if (screenshot.options.sendNotification) {
            let source = new Source('capture-NikoKrause', screenshot);
            Main.messageTray.add(source);

            // Load our icon into a texture for later use in notifications
            let icon_file = Gio.file_new_for_path(ICON_FILE_ACTIVE);
            let icon_uri = icon_file.get_uri();
            let icon_texture = St.TextureCache.get_default().load_uri_async(icon_uri, this._notificationIconSize, this._notificationIconSize);

            let image_file = Gio.file_new_for_path(screenshot.file);
            let image_uri = image_file.get_uri();
            let image_texture = St.TextureCache.get_default().load_uri_sync(
                St.TextureCachePolicy.NONE,
                image_uri,
                this._notificationImageSize, this._notificationImageSize);

            let body = _('Screenshot has been saved to:') + '\n' + image_file.get_parent().get_uri() +
                (screenshot.extraActionMessage ? "\n\n" + screenshot.extraActionMessage : "") +
                (screenshot.clipboardMessage ? "\n\n" + screenshot.clipboardMessage : "");

            let notification = new ScreenshotNotification(source,
                _("Screenshot captured!"), null, {
                    body: body,
                    customContent: true,
                    bodyMarkup: true
                });
            notification.setResident(true);
            notification.setImage(image_texture);
            this.addNotificationButtons(notification);

            notification.connect('action-invoked', Lang.bind(this, function(n, action_id) {
                return this.handleNotificationResponse(screenshot, action_id, n);
            }));

            // Left-click on notification image
            notification.connect('image-left-clicked', Lang.bind(this, function(n, s) {
                this._doRunHandler('file://' + screenshot.file);
            }));

            notification.connect('clicked', Lang.bind(this, function(n, s) {
                n.destroy();
            }));

            source.notify(notification);
        }

        return true;
    },

    addNotificationButtons: function(notification) {
        notification._buttonBox = null;
        if (this._showDeleteAction) {
            notification.addButton('delete-file', _('Delete'));
        }

        if (this._showCopyDataAction) {
            notification.addButton('copy-data', _('Copy Data'));
        }

        if (this._showCopyPathAction) {
            notification.addButton('copy-path', _('Copy Path'));
        }
    },

    handleNotificationResponse: function(screenshot, action, notification) {
        if ('delete-file' != action) {
            notification.setUrgency(MessageTray.Urgency.LOW);
            notification.setResident(false);
        }

        if ('close-notif' == action) {
            notification.destroy();
        } else if ('open-dir' == action) {
            if (this._canOpenFolderFile) {
                this.openFolderFile(screenshot.file);
            } else {
                this._doRunHandler('file://' + screenshot.outputDirectory);
            }
        } else if ('open-file' == action) {
            this._doRunHandler('file://' + screenshot.file);
        } else if ('copy-data' == action) {
            AppUtil.Exec('python ' + CLIPBOARD_HELPER + ' ' + screenshot.file);
        } else if ('copy-path' == action) {
            this.setClipboardText(screenshot.file);
        } else if ('open-link' == action) {
            this._doRunHandler(screenshot.json.link);
        } else if ('custom' == action) {
            AppUtil.Exec(this._customActionCmd + ' ' + screenshot.file);
        } else if ('delete-file' == action && !screenshot.demo) {
            notification.setUrgency(MessageTray.Urgency.CRITICAL);
            let file = Gio.file_new_for_path(screenshot.file);
            try {
                file.delete(null);
                let icon_file = Gio.file_new_for_path(ICON_FILE_ACTIVE);
                let icon_uri = icon_file.get_uri();
                let icon_texture = St.TextureCache.get_default().load_uri_async(icon_uri, this._notificationIconSize, this._notificationIconSize);

                notification.update(_('Screenshot deleted'), _("The screenshot at %s was removed from disk.").format(screenshot.file), {
                    body: _("The screenshot at %s was removed from disk.").format(screenshot.file),
                    icon: icon_texture,
                    customContent: true,
                    clear: true
                });

                Mainloop.timeout_add(1000, Lang.bind(this, function() {
                    notification.destroy();
                }));
            } catch (e) {
                global.log(e);
                global.log("Could not delete file " + file.get_path());
            }

        }

        return true;
    },

    run_cinnamon_camera: function(type, event, index) {
        let enableTimer = (this._delay > 0);

        if (type == Screenshot.SelectionType.REPEAT) {
            global.log("We shouldn't have reached run_cinnamon_camera.")
            return false;
        }

        let filename;
        try {
            filename = this._getCreateFilePath(this._cameraSaveDir, this.get_camera_filename(type), 'png');
        } catch (e) {
            filename = false;
            global.log(e);
        }

        if (false == filename) {
            return false;
        }

        let fnCapture = Lang.bind(this, function() {
            new Screenshot.ScreenshotHelper(type, Lang.bind(this, this.cinnamon_camera_complete), {
                includeCursor: this._includeCursor,
                useFlash: this._useCameraFlash,
                includeFrame: this._includeWindowFrame,
                includeStyles: this._includeStyles,
                windowAsArea: this._windowAsArea,
                playShutterSound: this._playShutterSound,
                playTimerSound: this._playIntervalSound,
                timerDuration: this._delay,
                soundTimerInterval: 'dialog-warning',
                soundShutter: 'camera-shutter',
                sendNotification: this._sendNotification,
                filename: filename,
                useIndex: index,
                openAfter: this._copyData ? false : this._openAfter,
            });
        });

        if (enableTimer || Screenshot.SelectionType.SCREEN != type) {
            fnCapture();
        } else {
            this.maybeCloseMenu();
            Mainloop.timeout_add(150, fnCapture);
        }
        return true;
    },

    maybeCloseMenu: function() {
        // Make sure we don't get our popup menu in the screenshot
        if (this._delay == 0) {
            this.menu.close(false);
        }
    },

    _update_cinnamon_recorder_status: function(actor) {
        let label = this._cRecorderItem.actor.get_children()[0];
        let newLabel = "";

        if (this.cRecorder.is_recording()) {
            newLabel = "   " + _("Stop recording");
        } else {
            newLabel = "   " + _("Start recording");
        }

        label.set_text(newLabel);
    },

    _getCreateFolder: function(folderPath, dontCreate) {
        let folder = Gio.file_new_for_path(folderPath);

        if (true != folder.query_exists(null)) {
            try {
                if (dontCreate == false) {
                    global.log("Save folder does not exist: " + folder.get_path() + ", aborting");
                    return false;
                }

                folder.make_directory(null);
            } catch (e) {
                global.log("Save folder does not exist: " + folder.get_path() + ", aborting");
                return false;
            }
        } else {
            let fileType = folder.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            /* Don't restrict to only directories, just exclude normal files */
            if (Gio.FileType.REGULAR == fileType) {
                global.log("Cannot write to " + folder.get_path() + ", not a directory, aborting");
                return false;
            }
        }

        return true;
    },

    _getCreateFilePath: function(folderPath, fileName, fileExtension) {
        if (false == this._getCreateFolder(folderPath, false)) {
            return false;
        }

        let file = Gio.file_new_for_path(folderPath + '/' + fileName + '.' + fileExtension);
        let desiredFilepath = file.get_path();
        try {
            if (file.create(Gio.FileCreateFlags.NONE, null)) {
                file.delete(null);
            } else {
                global.log("Could not create file " + file.get_path() + ", aborting");
                return false;
            }
        } catch (e) {
            global.log('Cannot open ' + desiredFilepath + ' for writing, aborting');
            return false;
        }

        return desiredFilepath;
    },

    _toggle_cinnamon_recorder: function(actor, event) {
        if (this.cRecorder.is_recording()) {
            this.cRecorder.pause();
            Meta.enable_unredirect_for_screen(global.screen);

            this._applet_icon.set_style_class_name('system-status-icon');
        } else {
            let filename;

            try {
                filename = this._getCreateFilePath(this._recorderSaveDir, this.get_recorder_filename(), this._crFileExtension);
            } catch (e) {
                filename = false;
                global.log(e);
            }

            if (false == filename) {
                global.log('no filename');
                return false;
            }

            this.cRecorder.set_filename(filename);
            global.log("Capturing screencast to " + filename);

            this.cRecorder.set_framerate(this._crFrameRate);

            let pipeline = this._crPipeline;
            global.log("Pipeline is " + pipeline);

            if (!pipeline.match(/^\s*$/))
                this.cRecorder.set_pipeline(pipeline);
            else
                this.cRecorder.set_pipeline(null);

            this._applet_icon.set_style_class_name('system-status-icon error');

            Meta.disable_unredirect_for_screen(global.screen);
            this.cRecorder.record();
        }

        this._update_cinnamon_recorder_status(actor);

        return true;
    },

    _launch_settings: function() {
        Main.Util.spawnCommandLine('cinnamon-settings applets ' + this._uuid);
    },

    applyCommandReplacements: function(cmd, mode) {
        let sDelay = "",
            sDefaults = "";

        if (this._delay > 0) {
            sDelay = this._delay;
        }

        let sDimensions = global.screen_width + 'x' + global.screen_height;

        let replacements = {
            '{DELAY}': sDelay,
            '{DIRECTORY}': mode == 'camera' ? this._cameraSaveDir : this._recorderSaveDir,
            '{SCREEN_DIMENSIONS}': sDimensions,
            '{SCREEN_WIDTH}': global.screen_width,
            '{SCREEN_HEIGHT}': global.screen_height,
            '{RECORDER_DIR}': this._recorderSaveDir,
            '{SCREENSHOT_DIR}': this._cameraSaveDir,
            '{FILENAME}': mode == 'camera' ? this.get_camera_filename() : this.get_recorder_filename()
        };

        for (var k in replacements) {
            cmd = cmd.replace(k, replacements[k]);
        }

        return cmd;
    },

    runCommand: function(cmd, mode, isCapture) {
        cmd = this.applyCommandReplacements(cmd, mode);

        // When taking a capture, allow the use of the screenshot helper
        // for choosing window or making an area selection.
        let interactiveCallouts = {
            '#DC_WINDOW_HELPER#': Screenshot.SelectionType.WINDOW,
            '#DC_AREA_HELPER#': Screenshot.SelectionType.AREA
        };

        let helperMode = null;
        for (var k in interactiveCallouts) {
            if (cmd.indexOf(k) === 0) {
                if (isCapture == true) {
                    helperMode = interactiveCallouts[k];
                    global.log('Using screenshot helper from capture mode "' + Screenshot.SelectionTypeStr[helperMode] + '"');
                }

                cmd = cmd.replace(k, '');
                if (cmd.charAt(0) == ' ') {
                    cmd = cmd.substr(1);
                }
                break;
            }
        }

        this.maybeCloseMenu();

        if (isCapture == true) {
            if (null !== helperMode) {
                let ss = new Screenshot.ScreenshotHelper(helperMode, Lang.bind(this, function(vars) {
                    this.runInteractiveCustom(cmd, vars);
                }), {
                    selectionHelper: true
                });
            } else {
                this.log('running ' + cmd);
                this.TryExec(cmd, Lang.bind(this, this.onProcessSpawned),
                    Lang.bind(this, this.onProcessError),
                    Lang.bind(this, this.onProcessComplete));
            }
        } else {
            this.TryExec(cmd);
        }

        return false;
    },

    runInteractiveCustom: function(cmd, vars) {
        //global.log('runInteractiveCustom');
        let niceHeight = vars['height'] % 2 == 0 ? vars['height'] : vars['height'] + 1,
            niceWidth = vars['width'] % 2 == 0 ? vars['width'] : vars['width'] + 1;

        let replacements = {
            '{X}': vars['x'],
            '{Y}': vars['y'],
            '{X_Y}': vars['x'] + ',' + vars['y'],
            '{WIDTH}': vars['width'],
            '{HEIGHT}': vars['height'],
            '{NICEWIDTH}': niceWidth,
            '{NICEHEIGHT}': niceHeight
        };

        if (vars['window']) {
            // numeric xwindow id e.g. to use with xprop/xwininfo
            replacements['{X_WINDOW_ID}'] = vars.window.get_meta_window().get_xwindow();
            replacements['{X_WINDOW_FRAME}'] = vars.window['x-window']; // Window frame
            replacements['{WM_CLASS}'] = vars.window.get_meta_window().get_wm_class();
            replacements['{WINDOW_TITLE}'] = vars.window.get_meta_window().get_title();
        }

        for (var k in replacements) {
            cmd = cmd.replace(k, replacements[k]);
        }

        this.log('running ' + cmd);
        this.TryExec(cmd, Lang.bind(this, this.onProcessSpawned),
            Lang.bind(this, this.onProcessError),
            Lang.bind(this, this.onProcessComplete));
    },

    onProcessSpawned: function(pid) {
        this._applet_icon.set_style_class_name('system-status-icon error');
    },

    onProcessError: function(cmd) {
        this._applet_icon.set_style_class_name('system-status-icon');
        this.Exec('zenity --info --title="Desktop Capture" --text="Command exited with error status:\n\n' +
            '<span font_desc=\'monospace 10\'>' + cmd.replace('"', '\"') + '</span>"')
    },

    onProcessComplete: function(status, stdout) {
        this.log("Process exited with status " + status);

        this._applet_icon.set_style_class_name('system-status-icon');
    },

    _set_program_available: function(program) {
        this._programs[program] = true;
    },

    _set_program_unavailable: function(program) {
        this._programs[program] = false;
    },

    Exec: function(cmd) {
        return AppUtil.Exec(cmd);
    },

    TryExec: function(cmd, onStart, onFailure, onComplete) {
        return AppUtil.TryExec(cmd, onStart, onFailure, onComplete, this.log);
    },

    on_applet_clicked: function(event) {
        this.menu.toggle();
    },

    _send_test_notification: function() {
        var enableTimer = (this._delay > 0);
        var options = {
            includeCursor: this._includeCursor,
            useFlash: this._useCameraFlash,
            includeFrame: this._includeWindowFrame,
            includeStyles: this._includeStyles,
            windowAsArea: this._windowAsArea,
            playShutterSound: this._playShutterSound,
            playTimerSound: this._playIntervalSound,
            timerDuration: this._delay,
            soundTimerInterval: 'dialog-warning',
            soundShutter: 'camera-shutter',
            sendNotification: this._sendNotification,
            filename: 'test.png',
            useIndex: 0,
            openAfter: this._copyData ? false : this._openAfter,
        };
        var screenshot = {
            selectionType: Screenshot.SelectionType.WINDOW,
            outputFilename: '',
            outputDirectory: '',
            file: '',
            options: options
        };

        this.cinnamon_camera_complete(screenshot);
    },

    on_config_demo_folder_open: function() {
        this.testCanOpenFolderFile();
    },

    on_config_demo_instructions: function() {
        let type = Screenshot.SelectionType.AREA;
        new Screenshot.ScreenshotHelper(type, Lang.bind(this, this.cinnamon_camera_complete), {
            includeCursor: this._includeCursor,
            useFlash: this._useCameraFlash,
            includeFrame: this._includeWindowFrame,
            includeStyles: this._includeStyles,
            windowAsArea: this._windowAsArea,
        });
    },

    testCanOpenFolderFile: function() {
        let query = 'xdg-mime query default inode/directory';
        let x = this.TryExec(query, null, null, Lang.bind(this, function(status, output) {
            let cmd = output.split('.desktop')[0];
            if (cmd == "nemo" || cmd == "nautilus") {
                this.log('Support for open folder/file enabled');
                this._canOpenFolderFile = true;
                this._fileman = cmd;
            } else {
                this._canOpenFolderFile = false;
                this._fileman = null;
                this.log('No support for open folder/file');
            }
        }));
    },

    openFolderFile: function(filename) {
        this.Exec(this._fileman + " " + filename);
    },

    on_config_demo_notification: function() {
        var enableTimer = (this._delay > 0);
        var options = {
            includeCursor: this._includeCursor,
            useFlash: this._useCameraFlash,
            includeFrame: this._includeWindowFrame,
            includeStyles: this._includeStyles,
            windowAsArea: this._windowAsArea,
            playShutterSound: this._playShutterSound,
            playTimerSound: this._playIntervalSound,
            timerDuration: this._delay,
            soundTimerInterval: 'dialog-warning',
            soundShutter: 'camera-shutter',
            sendNotification: this._sendNotification,
            filename: 'test.png',
            useIndex: 0,
            openAfter: this._copyData ? false : this._openAfter,
        };
        var screenshot = {
            selectionType: Screenshot.SelectionType.WINDOW,
            outputFilename: 'desktop-capture.png',
            outputDirectory: this._cameraSaveDir,
            file: ICON_FILE,
            options: options,
            demo: true
        };

        this.cinnamon_camera_complete(screenshot);

        let timeoutId = Mainloop.timeout_add(3000, Lang.bind(this, function() {
            this.on_settings_changed();
        }));
    },

    on_applet_removed_from_panel: function() {
        // Applet roles introduced in Cinnamon 2.2
        this.maybeUnregisterRole();
    },

    replaceTokens: function(tokens, replacements, subject) {
        if (tokens.length == replacements.length) {
            var i, t, p, r;
            for (i = 0; i < tokens.length; i++) {
                t = tokens[i];
                r = replacements[i];
                while (-1 != (p = subject.indexOf(t))) {
                    subject = subject.replace(t, r);
                }
            }
        }

        return subject;
    },

    maybeRegisterRole: function() {
        try {
            Main.systrayManager.registerRole("screenshot", this._uuid);
        } catch (e) {}
    },

    maybeUnregisterRole: function() {
        try {
            Main.systrayManager.unregisterRole("screenshot", this._uuid);
        } catch (e) {}
    },

};

function main(metadata, orientation, panelHeight, instanceId) {
    AppletDir = metadata.path;
    imports.searchPath.push(AppletDir);

    Screenshot = imports.cscreenshot;
    AppUtil = imports.apputil;

    ICON_FILE = AppletDir + '/icon.png';
    ICON_FILE_ACTIVE = AppletDir + '/icon-active.png';
    CLIPBOARD_HELPER = AppletDir + '/clip.py';

    let myApplet = new MyApplet(metadata, orientation, panelHeight, instanceId);
    return myApplet;
}