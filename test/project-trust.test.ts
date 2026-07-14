import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
  ProjectTrustChallengeError,
  ProjectTrustCoordinator,
  ProjectTrustRequiredError,
  type ProjectTrustDependencies,
  type ProjectTrustRequest,
} from "../src/control/project-trust.js";

interface TrustFixture {
  dependencies: ProjectTrustDependencies;
  required: boolean;
  saved: boolean | null;
  defaultDecision: "ask" | "always" | "never";
  remembered: Array<{ cwd: string; trusted: boolean }>;
}

function fixture(): TrustFixture {
  const state: TrustFixture = {
    required: true,
    saved: null,
    defaultDecision: "ask",
    remembered: [],
    dependencies: undefined as unknown as ProjectTrustDependencies,
  };
  state.dependencies = {
    requiresTrust: () => state.required,
    savedDecision: () => state.saved,
    defaultDecision: () => state.defaultDecision,
    remember: (cwd, trusted) => state.remembered.push({ cwd, trusted }),
  };
  return state;
}

function createRequest(
  input: Omit<ProjectTrustRequest, "operationType">,
): ProjectTrustRequest {
  return { operationType: "instance.create", ...input };
}

async function tempProject(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-trust-"));
  const project = join(root, "project");
  await mkdir(project);
  context.after(() => rm(root, { recursive: true, force: true }));
  return project;
}

async function required(promise: Promise<unknown>): Promise<ProjectTrustRequiredError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ProjectTrustRequiredError);
    return error;
  }
  assert.fail("Expected project trust challenge");
}

test("project trust skips challenge only when target needs no trust", async (context) => {
  const project = await tempProject(context);
  const alias = join(resolve(project, ".."), "alias");
  await symlink(project, alias);
  const state = fixture();
  state.required = false;
  const coordinator = new ProjectTrustCoordinator(state.dependencies);

  assert.deepEqual(await coordinator.resolve(createRequest({ operationId: "op-1", cwd: alias })), {
    canonicalCwd: project,
    projectTrusted: true,
  });
  await assert.rejects(
    coordinator.resolve(createRequest({
      operationId: "op-2",
      cwd: project,
      trustChallengeId: "unsolicited",
      projectTrustDecision: "trust_once",
    })),
    ProjectTrustChallengeError,
  );
  assert.deepEqual(state.remembered, []);
});

test("pending trust operation cannot rebind to a target that needs no trust", async (context) => {
  const trustedProject = await tempProject(context);
  const untrustedProject = join(resolve(trustedProject, ".."), "plain-project");
  await mkdir(untrustedProject);
  const state = fixture();
  state.dependencies.requiresTrust = (cwd) => cwd === trustedProject;
  const coordinator = new ProjectTrustCoordinator(state.dependencies, {
    createId: () => "challenge-1",
  });

  await required(coordinator.resolve(createRequest({
    operationId: "bound-operation",
    cwd: trustedProject,
    name: "alpha",
  })));
  await assert.rejects(
    coordinator.resolve(createRequest({
      operationId: "bound-operation",
      cwd: untrustedProject,
      name: "beta",
    })),
    (error: unknown) => error instanceof ProjectTrustChallengeError && /another project trust target/.test(error.message),
  );
});

test("project trust challenge is stable, target-bound, and consumed once", async (context) => {
  const project = await tempProject(context);
  const state = fixture();
  let idCalls = 0;
  const coordinator = new ProjectTrustCoordinator(state.dependencies, {
    now: () => 1_000,
    createId: () => `challenge-${++idCalls}`,
  });
  const request = createRequest({ operationId: "op-1", cwd: project, name: "alpha" });

  const first = await required(coordinator.resolve(request));
  const duplicate = await required(coordinator.resolve(request));
  assert.equal(first.details.challengeId, "challenge-1");
  assert.deepEqual(duplicate.details, first.details);
  assert.equal(idCalls, 1);

  await assert.rejects(
    coordinator.resolve({ ...request, name: "beta" }),
    (error: unknown) => error instanceof ProjectTrustChallengeError && /another project trust target/.test(error.message),
  );

  assert.deepEqual(await coordinator.resolve({
    ...request,
    trustChallengeId: first.details.challengeId,
    projectTrustDecision: "trust_and_remember",
  }), { canonicalCwd: project, projectTrusted: true });
  assert.deepEqual(state.remembered, [{ cwd: project, trusted: true }]);

  await assert.rejects(
    coordinator.resolve({
      ...request,
      trustChallengeId: first.details.challengeId,
      projectTrustDecision: "trust_and_remember",
    }),
    (error: unknown) => error instanceof ProjectTrustChallengeError && /consumed/.test(error.message),
  );
  await assert.rejects(
    coordinator.resolve({
      ...request,
      operationType: "session.switch",
      trustChallengeId: first.details.challengeId,
      projectTrustDecision: "trust_and_remember",
    }),
    (error: unknown) => error instanceof ProjectTrustChallengeError && /cannot be rebound/.test(error.message),
  );
  assert.equal(state.remembered.length, 1);
});

test("project trust deny continues untrusted and expiry becomes a target tombstone", async (context) => {
  const project = await tempProject(context);
  const state = fixture();
  let now = 10;
  let ids = 0;
  const coordinator = new ProjectTrustCoordinator(state.dependencies, {
    now: () => now,
    ttlMs: 50,
    createId: () => `challenge-${++ids}`,
  });

  const first = await required(coordinator.resolve(createRequest({ operationId: "deny", cwd: project })));
  assert.deepEqual(await coordinator.resolve(createRequest({
    operationId: "deny",
    cwd: project,
    trustChallengeId: first.details.challengeId,
    projectTrustDecision: "deny_once",
  })), { canonicalCwd: project, projectTrusted: false });
  assert.deepEqual(state.remembered, []);

  await required(coordinator.resolve(createRequest({ operationId: "expires", cwd: project, name: "alpha" })));
  now = 60;
  await assert.rejects(
    coordinator.resolve(createRequest({ operationId: "expires", cwd: project, name: "alpha" })),
    (error: unknown) => error instanceof ProjectTrustChallengeError && /expired/.test(error.message),
  );
  await assert.rejects(
    coordinator.resolve(createRequest({ operationId: "expires", cwd: project, name: "beta" })),
    (error: unknown) => error instanceof ProjectTrustChallengeError && /cannot be rebound/.test(error.message),
  );
  assert.equal(ids, 2);
});

test("global expiry pruning preserves operation bindings", async (context) => {
  const project = await tempProject(context);
  const state = fixture();
  let now = 0;
  let ids = 0;
  const coordinator = new ProjectTrustCoordinator(state.dependencies, {
    now: () => now,
    ttlMs: 10,
    createId: () => `challenge-${++ids}`,
  });

  await required(coordinator.resolve(createRequest({ operationId: "old", cwd: project, name: "alpha" })));
  now = 11;
  await required(coordinator.resolve(createRequest({ operationId: "new", cwd: project })));
  await assert.rejects(
    coordinator.resolve(createRequest({ operationId: "old", cwd: project, name: "beta" })),
    (error: unknown) => error instanceof ProjectTrustChallengeError && /cannot be rebound/.test(error.message),
  );
  assert.equal(ids, 2);
});

test("trust binding capacity fails closed without evicting tombstones", async (context) => {
  const project = await tempProject(context);
  const state = fixture();
  let ids = 0;
  const coordinator = new ProjectTrustCoordinator(state.dependencies, {
    bindingCapacity: 2,
    createId: () => `challenge-${++ids}`,
  });

  const first = await required(coordinator.resolve(createRequest({ operationId: "one", cwd: project })));
  await coordinator.resolve(createRequest({
    operationId: "one",
    cwd: project,
    trustChallengeId: first.details.challengeId,
    projectTrustDecision: "trust_once",
  }));
  await required(coordinator.resolve(createRequest({ operationId: "two", cwd: project })));
  await assert.rejects(
    coordinator.resolve(createRequest({ operationId: "three", cwd: project })),
    (error: unknown) => error instanceof ProjectTrustChallengeError && /capacity is exhausted/.test(error.message),
  );
  await assert.rejects(
    coordinator.resolve({
      operationType: "session.switch",
      operationId: "one",
      cwd: project,
    }),
    (error: unknown) => error instanceof ProjectTrustChallengeError && /cannot be rebound/.test(error.message),
  );
  assert.equal(ids, 2);
});

test("saved and global defaults resolve without challenge", async (context) => {
  const project = await tempProject(context);
  const state = fixture();
  const coordinator = new ProjectTrustCoordinator(state.dependencies);

  state.saved = false;
  assert.equal((await coordinator.resolve(createRequest({ operationId: "saved-false", cwd: project }))).projectTrusted, false);
  state.saved = true;
  assert.equal((await coordinator.resolve(createRequest({ operationId: "saved-true", cwd: project }))).projectTrusted, true);
  state.saved = null;
  state.defaultDecision = "always";
  assert.equal((await coordinator.resolve(createRequest({ operationId: "always", cwd: project }))).projectTrusted, true);
  state.defaultDecision = "never";
  assert.equal((await coordinator.resolve(createRequest({ operationId: "never", cwd: project }))).projectTrusted, false);
});
