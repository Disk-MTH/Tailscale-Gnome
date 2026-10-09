// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

const SHELL_MAJOR = Number.parseInt(Config.PACKAGE_VERSION, 10);

// GNOME 48 introduced orientation; GNOME 51 removed vertical.
const VERTICAL_ORIENTATION = SHELL_MAJOR >= 48
    ? { orientation: Clutter.Orientation.VERTICAL }
    : { vertical: true };

export function verticalBox(params = {}) {
    return new St.BoxLayout({ ...params, ...VERTICAL_ORIENTATION });
}
