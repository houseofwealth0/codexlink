const test = require("node:test");
const assert = require("node:assert/strict");
const { createSetupPlan, actionsForMode, stablePattern } = require("../packages/shared/src/setup-agent");

function report(overrides = {}) {
  return {
    appName: "sample",
    appType: "node",
    packageManager: "npm",
    replit: { hasReplitFile: true },
    files: {
      hasReplit: true,
      hasPackageJson: true,
      hasRequirements: false
    },
    git: { present: true, dirty: false },
    ...overrides
  };
}

test("creates a setup plan with safe config and startup actions", () => {
  const plan = createSetupPlan({
    report: report(),
    controllerUrl: "http://localhost:8787",
    appId: "app-1",
    appToken: "token-1"
  });

  assert.equal(plan.appName, "sample");
  assert.equal(plan.recommendedMode, "safe");
  assert.ok(plan.actions.some((action) => action.id === "write-config" && action.risk === "safe"));
  assert.ok(plan.actions.some((action) => action.id === "write-worker-daemon" && action.risk === "safe"));
  assert.ok(plan.actions.some((action) => action.id === "patch-package-json" && action.risk === "startup"));
  assert.ok(plan.actions.some((action) => action.id === "patch-replit-onboot" && action.risk === "startup"));
});

test("safe mode splits low-risk and approval-required actions", () => {
  const plan = createSetupPlan({
    report: report(),
    controllerUrl: "http://localhost:8787",
    appId: "app-1",
    appToken: "token-1"
  });

  const split = actionsForMode(plan, "safe");
  assert.ok(split.auto.length > 0);
  assert.ok(split.needsApproval.length > 0);
  assert.ok(split.auto.every((action) => action.risk === "safe"));
});

test("pattern key is stable for matching app shape", () => {
  assert.equal(stablePattern(report()), stablePattern(report({ appName: "other-name" })));
});
