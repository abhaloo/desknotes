import test from "node:test";
import assert from "node:assert/strict";
import { createWindowPresenter } from "../src/desktop/window-presenter.js";

/** A window that records each call in order. */
function fakeWindow({ destroyed = false } = {}) {
  return {
    calls: [],
    isDestroyed: () => destroyed,
    setOpacity(value) { this.calls.push(["opacity", value]); },
    show() { this.calls.push(["show"]); },
    showInactive() { this.calls.push(["showInactive"]); },
    hide() { this.calls.push(["hide"]); },
  };
}

test("show(win, {inactive: true}) calls showInactive, never show", () => {
  const win = fakeWindow();
  createWindowPresenter({ getOpacity: () => 0.8 }).show(win, { inactive: true });
  assert.deepEqual(win.calls, [["opacity", 0.8], ["showInactive"]]);
});

test("show with no options is inactive, so the overlay never takes focus from the call", () => {
  const win = fakeWindow();
  createWindowPresenter().show(win);
  assert.deepEqual(win.calls, [["opacity", 1], ["showInactive"]]);
});

test("show(win, {inactive: false}) shows and focuses", () => {
  const win = fakeWindow();
  createWindowPresenter({ getOpacity: () => 0.8 }).show(win, { inactive: false });
  assert.deepEqual(win.calls, [["opacity", 0.8], ["show"]]);
});

test("applyOpacity sets the current opacity", () => {
  const win = fakeWindow();
  let opacity = 0.5;
  const presenter = createWindowPresenter({ getOpacity: () => opacity });
  presenter.applyOpacity(win);
  opacity = 0.9;
  presenter.applyOpacity(win);
  assert.deepEqual(win.calls, [["opacity", 0.5], ["opacity", 0.9]]);
});

test("hide(win) hides the window", () => {
  const win = fakeWindow();
  createWindowPresenter().hide(win);
  assert.deepEqual(win.calls, [["hide"]]);
});

test("a destroyed or missing window is ignored", () => {
  const win = fakeWindow({ destroyed: true });
  const presenter = createWindowPresenter({ getOpacity: () => 0.8 });
  presenter.show(win, { inactive: false });
  presenter.show(win);
  presenter.hide(win);
  presenter.applyOpacity(win);
  assert.deepEqual(win.calls, []);
  assert.doesNotThrow(() => {
    presenter.show(null);
    presenter.hide(undefined);
    presenter.applyOpacity(null);
  });
});
