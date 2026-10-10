// test/permission.test.mjs — 权限折叠与策略映射。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readPermission, permissionStrategy, isWithinWorkspace } from "../lib/permission.mjs";
import { foldPermission } from "../lib/session-events.mjs";

const ev = (type, data) => ({ type, data, seq: 0 });

test("readPermission 取最后一次 sandbox/mode 与 approval/policy", () => {
  const events = [
    ev("sandbox/mode", { mode: "read-only" }),
    ev("approval/policy", { policy: "ask" }),
    ev("sandbox/mode", { mode: "workspace-write" }),
  ];
  assert.deepEqual(readPermission(events), { mode: "workspace-write", policy: "ask" });
  assert.deepEqual(foldPermission(events), readPermission(events));
});

test("没有权限事件时两个字段都是 undefined", () => {
  assert.deepEqual(readPermission([]), { mode: undefined, policy: undefined });
});

test("permissionStrategy 映射", () => {
  assert.equal(permissionStrategy({ mode: "danger-full-access", policy: "ask" }), "bypass");
  assert.equal(permissionStrategy({ mode: "workspace-write", policy: "never" }), "no-prompt");
  assert.equal(permissionStrategy({ mode: "workspace-write", policy: "ask" }), "ask");
  assert.equal(permissionStrategy({ mode: "read-only", policy: "ask" }), "ask");
  assert.equal(permissionStrategy({}), "ask");
  assert.equal(permissionStrategy(), "ask");
});

test("danger-full-access 优先于 never（先判 bypass）", () => {
  assert.equal(permissionStrategy({ mode: "danger-full-access", policy: "never" }), "bypass");
});

test("isWithinWorkspace 判定工作区内外", () => {
  const cwd = process.platform === "win32" ? "C:\\work\\prj" : "/work/prj";
  assert.equal(isWithinWorkspace(cwd, cwd), true);
  assert.equal(isWithinWorkspace(cwd, `${cwd}${process.platform === "win32" ? "\\" : "/"}src\\a.ts`), true);
  assert.equal(isWithinWorkspace(cwd, process.platform === "win32" ? "C:\\other\\a.ts" : "/other/a.ts"), false);
  assert.equal(isWithinWorkspace(undefined, "x"), false);
  assert.equal(isWithinWorkspace(cwd, undefined), false);
});
