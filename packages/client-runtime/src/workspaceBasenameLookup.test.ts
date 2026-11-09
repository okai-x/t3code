import { describe, expect, it } from "vite-plus/test";
import { pickWorkspaceSuffixMatch } from "./workspaceBasenameLookup.ts";

const file = (path: string) => ({ path, kind: "file" as const });

describe("pickWorkspaceSuffixMatch", () => {
  it("resolves a path cited from inside a package to its one workspace file", () => {
    const entries = [
      file("src/data_factory/application/agents.py"),
      file("src/data_factory/application/agent_phase.py"),
      file("tests/test_agent_phase.py"),
    ];
    expect(pickWorkspaceSuffixMatch("application/agent_phase.py", "/repo", entries)).toBe(
      "src/data_factory/application/agent_phase.py",
    );
  });

  it("matches whole path segments only", () => {
    const entries = [file("src/my_application/agent_phase.py")];
    expect(pickWorkspaceSuffixMatch("application/agent_phase.py", "/repo", entries)).toBeNull();
  });

  it("refuses an ambiguous suffix", () => {
    const entries = [file("apps/web/src/index.ts"), file("apps/mobile/src/index.ts")];
    expect(pickWorkspaceSuffixMatch("src/index.ts", "/repo", entries)).toBeNull();
  });

  it("ignores directories and folds case on Windows workspaces", () => {
    const entries = [
      { path: "pkg/Application/agent_phase.py", kind: "directory" as const },
      file("src\\Pkg\\Application\\Agent_Phase.py"),
    ];
    expect(pickWorkspaceSuffixMatch("pkg/application/agent_phase.py", "C:\\repo", entries)).toBe(
      "src\\Pkg\\Application\\Agent_Phase.py",
    );
  });
});
