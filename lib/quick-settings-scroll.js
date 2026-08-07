// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// ===========================================================================
// TEMPORARY WORKAROUND. Delete this file, its GSettings key
// (`quick-settings-scroll`), its row in prefs/general.js, its rule in
// stylesheet.css and the four lines that drive it in extension.js once GNOME
// Shell scrolls its own Quick Settings menu. Nothing else in the extension
// imports it.
// ===========================================================================
//
// A Quick Settings menu taller than the screen runs off the bottom and there
// is no way to reach what is down there. Three things in the shell add up to
// that, all in GNOME 49/50:
//
//  1. PanelMenu.Button._onOpenStateChanged does set a max-height on
//     `menu.actor` on every open. But QuickSettingsMenu replaces `actor` with
//     a 0x0 St.Widget that only exists to host the submenu overlay, so the
//     ceiling lands on an actor that constrains nothing.
//  2. There is no scroll view at the top level. PopupSubMenu has one, which
//     is why submenus scroll and the menu holding them does not; PopupMenu
//     itself only does `_boxPointer.bin.set_child(this.box)`.
//  3. The submenus are not inside the popup at all. `_overlay` is a sibling
//     of `_boxPointer` under that 0x0 widget, kept over the right row by
//     constraints. Scrolling the grid without it would leave an open submenu
//     painted outside the menu, over the panel and the desktop.
//
// So: a scroll view around the grid *and* the overlay, and a ceiling in a
// place that actually bites. No shell method is replaced. `addItem`,
// `insertItemBefore`, `getFirstItem`, `open` and `close` go on driving the
// same `_grid` and `_overlay` objects, which have only been reparented, so
// other extensions adding toggles see no difference.
//
//   before                             after
//   ------                             -----
//   actor        St.Widget 0x0         actor
//   +- _boxPointer                     +- _boxPointer   <- max-height here
//   |  +- bin                          |  +- bin
//   |     +- box  .quick-settings      |     +- box
//   |        +- _grid                  |        +- scrollView
//   +- _overlay   (submenus)           |           +- stack  BinLayout
//                                      |              +- _grid
//                                      |              +- _overlay
//                                      +- (empty)

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Logical pixels left between the popup and the edge of the work area, so a
// menu that had to be clamped does not sit flush against the screen.
const EDGE_MARGIN = 12;

// The shell dims the whole box pointer while a submenu is up, so the grid
// recedes and the submenu stands out. That worked because the overlay sat
// outside the box pointer; now that it is inside, the dim covers the submenu
// too and the effect reads as a bug. GNOME's own attempt at this patch,
// merge request !3272, restructures the tree exactly the way this file does
// and hits the same wall, so the answer here is theirs: a counterweight
// brightness effect on the submenu, on while it is up.
const DIM_BRIGHTNESS = -0.4;   // as in js/ui/quickSettings.js
// 127.5 is the neutral byte of a Cogl brightness colour, and !3272 winds the
// submenu back up to 255 * (1 + DIM_BRIGHTNESS). Same figure, written as the
// [-1, 1] factor Clutter takes.
const UNDIM = (255 * (1 + DIM_BRIGHTNESS)) / 127.5 - 1;
const UNDIM_NAME = 'tailscale-undim';

export class QuickSettingsScroll {
    constructor() {
        this._menu = null;
        this._scrollView = null;
        this._stack = null;
        this._themeContext = null;
        // Everything _revert() needs to put the shell back exactly as it was.
        this._overlayConstraints = null;
        this._overlayLayout = null;
        this._boxPointerStyle = null;
    }

    /**
     * Follow the setting. Idempotent both ways: the extension calls this on
     * enable and on every `changed::`, and neither has to know the state.
     *
     * @param {boolean} wanted
     */
    setEnabled(wanted) {
        if (wanted) this._apply();
        else this._revert();
    }

    destroy() {
        this._revert();
    }

    /* ------------------------------- apply ------------------------------ */

    _apply() {
        if (this._scrollView) return;

        const menu = Main.panel.statusArea.quickSettings?.menu;
        // A shell whose Quick Settings no longer looks like the tree above.
        // Nothing is touched: a half-built patch would be worse than a menu
        // that still cannot scroll.
        if (!menu?.box || !menu._grid || !menu._overlay || !menu._boxPointer)
            return;

        const {box, _grid: grid, _overlay: overlay} = menu;

        // Recorded before anything moves, so _revert() has what it needs
        // even if the surgery below gives up half way.
        this._menu = menu;
        this._boxPointerStyle = menu._boxPointer.style;
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);

        this._scrollView = new St.ScrollView({
            style_class: 'tailscale-quick-settings-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // EXTERNAL rather than NEVER, and it is not a detail: NEVER makes
            // the view's own minimum height that of its child, which is the
            // very thing the max-height below has to be free to override.
            // EXTERNAL reports a minimum of zero and draws no scrollbar,
            // which is exactly the pair we want. Neither policy stops the
            // wheel: st_scroll_view_scroll_event never reads it.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });

        // The grid and the overlay have to travel together: the overlay is
        // drawn over the grid and its submenus are placed in grid
        // coordinates. A BinLayout stacks the two at one origin, which is
        // the invariant the shell was getting from the constraints removed
        // just below.
        //
        // St.Viewport and not St.Widget: a ScrollView only takes a child
        // that implements StScrollable, and Viewport is the one that does it
        // while still taking whatever layout manager it is handed. It also
        // scrolls by transform rather than by reallocation, so the grid's
        // own x/y never move and the shell's updateOffset() handlers stay
        // quiet while the wheel turns.
        this._stack = new St.Viewport({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });

        box.remove_child(grid);
        menu.actor.remove_child(overlay);

        // Kept as objects, not read into values: putting these very
        // constraints back is what leaves the shell's own updateOffset()
        // handlers, which hold them in a closure we cannot reach, driving
        // exactly what they drove before. Meanwhile they go on being written
        // to and nothing reads them, which is the entire cost of leaving
        // those handlers connected.
        this._overlayConstraints = overlay.get_constraints();
        for (const constraint of this._overlayConstraints)
            overlay.remove_constraint(constraint);

        this._overlayLayout = {
            x_expand: overlay.x_expand,
            y_expand: overlay.y_expand,
            x_align:  overlay.x_align,
            y_align:  overlay.y_align,
        };
        // y_expand has to be on, counter-intuitively, and START is what does
        // the work. clutter-bin-layout.c reads a child's y_align only when
        // that child needs expand; without it the layout takes its other
        // branch and hardcodes an alignment factor of 0.5, which centres the
        // overlay and drops every submenu half the grid's height too low.
        // Expanding does not stretch it: the stretch is governed by y_fill,
        // which that same code sets only when the alignment is FILL. START
        // therefore lands the actor at its natural height on the grid's own
        // origin, which is the invariant the shell's constraints used to
        // hold. Stretching is what must not happen: the grid reserves room
        // for an open submenu through a placeholder bound to this actor's
        // height, so an overlay filled to the stack would feed the grid's
        // height back into it and the layout would never settle.
        overlay.set({
            x_expand: true,
            y_expand: true,
            x_align:  Clutter.ActorAlign.FILL,
            y_align:  Clutter.ActorAlign.START,
        });

        this._stack.add_child(grid);
        this._stack.add_child(overlay);   // added second: drawn over the grid
        this._scrollView.child = this._stack;
        box.add_child(this._scrollView);

        this._watchSubmenus(overlay);

        this._themeContext.connectObject(
            'notify::scale-factor', () => this._clamp(), this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._clamp(), this);
        menu.connectObject('open-state-changed', (_m, isOpen) => {
            // Recomputed per open like the shell does with its own ceiling,
            // and wound back on close so the menu never reopens halfway
            // down where it was left.
            if (isOpen) this._clamp();
            else this._scrollView.vadjustment.value = 0;
        }, this);

        this._clamp();
    }

    /* ------------------------------- undim ------------------------------ */

    // Submenu actors come and go as extensions add and remove toggles, so
    // this follows the overlay's children rather than taking one snapshot.
    _watchSubmenus(overlay) {
        for (const actor of overlay) this._addUndim(actor);
        overlay.connectObject(
            'child-added',   (_o, actor) => this._addUndim(actor),
            'child-removed', (_o, actor) => this._removeUndim(actor),
            this);
    }

    _addUndim(actor) {
        if (actor.get_effect(UNDIM_NAME)) return;

        const effect = new Clutter.BrightnessContrastEffect();
        effect.set_brightness(UNDIM);
        effect.enabled = actor.visible;
        actor.add_effect_with_name(UNDIM_NAME, effect);

        // `visible` is the honest signal: QuickToggleMenu shows its actor on
        // open and hides it once the close animation has run, and the grid's
        // own layout decides where to leave a gap off that same property.
        actor.connectObject('notify::visible',
            () => (effect.enabled = actor.visible), this);
    }

    _removeUndim(actor) {
        actor.disconnectObject(this);
        if (actor.get_effect(UNDIM_NAME))
            actor.remove_effect_by_name(UNDIM_NAME);
    }

    /* ------------------------------- clamp ------------------------------ */

    // What actually makes the thing scroll: a scroll view scrolls only when
    // something bounds its height, and nothing here does. The ceiling goes on
    // the BoxPointer rather than on the view because BoxPointer's
    // vfunc_get_preferred_height ends in themeNode.adjust_preferred_height,
    // so the figure it reads covers the whole popup, arrow and borders
    // included, and there is no chrome left over to guess at.
    _clamp() {
        if (!this._scrollView) return;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            Main.layoutManager.primaryIndex);
        // The work area is in physical pixels and a CSS length is a logical
        // one, so the scale factor has to come back out before this is
        // written into a style.
        const scale = this._themeContext.scale_factor || 1;
        const maxHeight = Math.round(workArea.height / scale) - EDGE_MARGIN;

        // A zero-height work area is not hypothetical: the shell hands one
        // out before the first monitor has landed. The ceiling computed from
        // it comes out negative, and a negative max-height collapses the
        // popup to its bare arrow. Leave the last good one standing; the
        // monitors-changed that follows recomputes it.
        if (maxHeight <= 0) return;

        this._menu._boxPointer.style = `max-height: ${maxHeight}px;`;
    }

    /* ------------------------------ revert ------------------------------ */

    // The Quick Settings menu outlives the extension: it is the shell's, and
    // it is still there after disable(). So this has to be exact, not merely
    // close, and it runs in reverse order of _apply().
    _revert() {
        if (!this._scrollView) return;

        const menu = this._menu;
        const {box, _grid: grid, _overlay: overlay} = menu;

        menu.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._themeContext.disconnectObject(this);

        for (const actor of overlay) this._removeUndim(actor);
        overlay.disconnectObject(this);

        // Both are pulled out before the view goes: destroying a ScrollView
        // takes everything still inside it with it, and of the three actors
        // in there only the stack is ours.
        this._stack.remove_child(grid);
        this._stack.remove_child(overlay);
        box.remove_child(this._scrollView);
        this._scrollView.destroy();   // and the now-empty stack with it

        // Guarded, not assumed: an _apply() that gave up part way through
        // still has to leave disable() able to run to the end.
        if (this._overlayLayout) overlay.set(this._overlayLayout);
        for (const constraint of this._overlayConstraints ?? [])
            overlay.add_constraint(constraint);

        box.add_child(grid);
        menu.actor.add_child(overlay);
        menu._boxPointer.style = this._boxPointerStyle;

        this._scrollView = null;
        this._stack = null;
        this._themeContext = null;
        this._overlayConstraints = null;
        this._overlayLayout = null;
        this._boxPointerStyle = null;
        this._menu = null;
    }
}
