#!/usr/bin/env python3
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (c) 2026 PIIIX-org contributors
"""Real OMP session jobs and peer RPC; disposable HOME, no model turns or credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from smoke import OMP, Peer, REPO, wait_for

sys.path.insert(0, str(REPO / "tools"))
from watch import peer_rpc

# Commands exercise the host job manager in this one disposable process. Completion
# is acknowledged before resolving so it cannot wake a model turn.
FIXTURE = r'''
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
export default function fixture(pi) {
    let job;
    let body;
    pi.registerCommand("activity-smoke", {
        description: "Disposable offline job fixture",
        handler: async (action, ctx) => {
            const manager = AsyncJobManager.instance();
            const ref = AgentRegistry.global().get(ctx.agent.id);
            if (!manager || ref?.session?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
                throw new Error("isolated host job manager unavailable");
            }
            if (action === "start") {
                body = Promise.withResolvers();
                job = manager.register("bash", "offline activity smoke", ({signal}) => {
                    signal.addEventListener("abort", () => body.reject(signal.reason), {once: true});
                    return body.promise;
                }, {ownerId: ctx.agent.id});
            } else if (action === "finish") {
                manager.acknowledgeDeliveries([job]);
                body.resolve("offline complete");
                await manager.getJob(job).promise;
            } else if (action === "cancel") {
                manager.cancel(job, {ownerId: ctx.agent.id});
                await manager.getJob(job).promise;
            } else throw new Error("unsupported fixture command");
            ctx.ui.notify("activity-smoke:" + action, "info");
        }
    });
}
'''


def main():
    if not OMP:
        raise SystemExit("Install OMP before running this smoke test.")
    peer = None
    with tempfile.TemporaryDirectory(prefix="opa-", dir="/tmp") as root:
        home = Path(root)
        agent = home / ".omp/agent"
        extensions = agent / "extensions"
        extensions.mkdir(parents=True)
        (extensions / "activity-smoke.ts").write_text(FIXTURE)
        (agent / "config.yml").write_text(
            "autoResume: false\nsetupVersion: 2\nstartup:\n  setupWizard: false\n"
            "  checkUpdate: false\nrecap:\n  enabled: false\nproviders:\n  cacheWarming: off\n"
        )
        (agent / "models.yml").write_text(
            "providers:\n  smoke:\n    baseUrl: http://127.0.0.1:9/v1\n"
            "    api: openai-completions\n    auth: none\n    models:\n      - id: first\n"
        )
        env = {"HOME": root, "PATH": os.environ["PATH"], "TERM": "dumb",
               "PI_CODING_AGENT_DIR": str(agent), "TMPDIR": root,
               "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
               "XDG_CACHE_HOME": str(home / "cache"), "XDG_STATE_HOME": str(home / "state")}
        try:
            installed = subprocess.run([OMP, "plugin", "link", str(REPO)], env=env, cwd=root,
                                       capture_output=True, text=True, timeout=60)
            assert installed.returncode == 0, installed.stdout + installed.stderr
            peer = Peer(env, root)
            peer.call("get_state")
            registry = home / ".omp/run/peers"

            def row():
                rows = [json.loads(path.read_text()) for path in registry.glob("p*.json")]
                return rows[0] if len(rows) == 1 else None

            identity = wait_for(row)

            def status():
                return peer_rpc(identity, {"op": "status"})["info"]

            wait_for(lambda: status().get("isSettled") is True)
            for outcome in ("finish", "cancel"):
                peer.command("/activity-smoke start", "activity-smoke:start")
                pending = status()
                assert pending["activity"]["activeJobs"] == 1, pending
                assert pending["activity"]["activeSubagents"] == 0, pending
                assert pending["hasPendingAsyncWork"] is True, pending
                assert pending["isSettled"] is False, pending
                wait_for(lambda: row()["activity"]["activeJobs"] == 1)
                peer.command("/activity-smoke " + outcome, "activity-smoke:" + outcome)
                settled = wait_for(lambda: status() if status()["isSettled"] is True else None)
                assert settled["activity"]["activeJobs"] == 0, settled
                assert settled["hasPendingAsyncWork"] is False, settled
                wait_for(lambda: row()["activity"]["activeJobs"] == 0 and row()["isSettled"] is True)
            assert not any(frame.get("type") in ("agent_start", "extension_error") for frame in peer.frames), peer.frames
            print("PASS real session jobs: pending, completed, cancelled; RPC and registry counts; no model turns")
        finally:
            if peer:
                peer.close()
        assert not list(registry.glob("p*.json")), "disposable peer registration survived shutdown"
    print("PASS disposable process, extension fixture, home and job state removed")


if __name__ == "__main__":
    main()
