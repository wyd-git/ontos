import assert from "node:assert/strict";
import test from "node:test";

import {
  MANAGEMENT_PERMISSIONS,
  isManagementPermissionAllowed,
  permissionsForRole,
  type ManagementRole,
} from "@ontos/metadata-domain";

const roles: readonly ManagementRole[] = ["owner", "editor", "viewer", "executor", "auditor"];
const expected: Readonly<Record<ManagementRole, readonly string[]>> = {
  owner: [...MANAGEMENT_PERMISSIONS],
  editor: ["metadata.read", "metadata.edit"],
  viewer: ["metadata.read"],
  executor: [],
  auditor: [],
};

for (const role of roles) {
  void test(`${role} has the exact G2-01 management permission matrix`, () => {
    for (const permission of MANAGEMENT_PERMISSIONS) {
      assert.equal(
        isManagementPermissionAllowed({ projectRole: role, resourceRole: null }, permission, false),
        expected[role].includes(permission),
        `${role}:${permission}`,
      );
    }
    assert.deepEqual([...permissionsForRole(role)], expected[role]);
  });
}

void test("a Resource binding narrows but never expands its Project role", () => {
  assert.equal(
    isManagementPermissionAllowed(
      { projectRole: "editor", resourceRole: "viewer" },
      "metadata.edit",
      true,
    ),
    false,
  );
  assert.equal(
    isManagementPermissionAllowed(
      { projectRole: "viewer", resourceRole: "owner" },
      "metadata.edit",
      true,
    ),
    false,
  );
  assert.equal(
    isManagementPermissionAllowed(
      { projectRole: "editor", resourceRole: null },
      "metadata.edit",
      true,
    ),
    true,
  );
  assert.equal(
    isManagementPermissionAllowed(
      { projectRole: null, resourceRole: "owner" },
      "metadata.read",
      true,
    ),
    false,
  );
  // G2_NEGATIVE:role_overreach
});
