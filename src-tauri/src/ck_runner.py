"""Grimcut's CorridorKey runner.

Grimcut writes this file next to its on-demand CorridorKey install and runs it as
`python grimcut_ck.py job.json`. It streams frames: FFmpeg decodes the clip to RGBA
(RGB = footage, A = Grimcut's chroma key as the coarse alpha hint), CorridorKey refines
each frame, and a second FFmpeg encodes the straight RGBA result.

Progress goes to stdout as `PROGRESS <done> <total>`; a failure ends with `ERROR <text>`.
"""

import json
import os
import subprocess
import sys

CREATE_NO_WINDOW = 0x08000000


def main() -> int:
    with open(sys.argv[1], encoding="utf-8") as f:
        job = json.load(f)
    sys.path.insert(0, job["module_dir"])
    os.environ.setdefault("CORRIDORKEY_SKIP_COMPILE", "1")

    import numpy as np
    import torch

    from CorridorKeyModule.core import color_utils as cu
    from CorridorKeyModule.inference_engine import CorridorKeyEngine

    device = job["device"]
    if device == "cuda" and not torch.cuda.is_available():
        print("WARN CUDA not available, using CPU", flush=True)
        device = "cpu"
    if device == "cpu":
        torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
    print(f"DEVICE {device}", flush=True)

    engine = CorridorKeyEngine(
        checkpoint_path=job["checkpoint"],
        device=device,
        img_size=int(job["img_size"]),
        mixed_precision=device == "cuda",
        model_precision=torch.float16 if device == "cuda" else torch.float32,
    )

    w, h, total = int(job["width"]), int(job["height"]), int(job["frames"])
    flags = CREATE_NO_WINDOW if sys.platform == "win32" else 0
    dec = subprocess.Popen(job["decode"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)
    enc = subprocess.Popen(job["encode"], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)
    frame_bytes = w * h * 4
    done = 0
    try:
        while True:
            buf = dec.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            rgba = np.frombuffer(buf, np.uint8).reshape(h, w, 4)
            image = np.ascontiguousarray(rgba[:, :, :3])
            hint = np.ascontiguousarray(rgba[:, :, 3])
            res = engine.process_frame(
                image,
                hint,
                despill_strength=float(job.get("despill", 1.0)),
                auto_despeckle=bool(job.get("despeckle", True)),
                despeckle_size=int(job.get("despeckle_size", 400)),
                generate_comp=False,
                post_process_on_gpu=device == "cuda",
                screen_channel=int(job.get("screen_channel", 1)),
            )
            proc = np.asarray(res["processed"], dtype=np.float32)
            alpha = np.clip(proc[:, :, 3:4], 0.0, 1.0)
            fg_lin = np.where(alpha > 1e-4, proc[:, :, :3] / np.maximum(alpha, 1e-4), 0.0)
            fg = np.clip(cu.linear_to_srgb(np.clip(fg_lin, 0.0, 1.0)), 0.0, 1.0)
            out = np.concatenate([fg, alpha], axis=-1)
            enc.stdin.write((out * 255.0 + 0.5).astype(np.uint8).tobytes())
            done += 1
            print(f"PROGRESS {done} {max(total, done)}", flush=True)
    finally:
        try:
            enc.stdin.close()
        except Exception:
            pass
        enc.wait()
        dec.kill()
    if done == 0:
        print("ERROR no frames decoded", flush=True)
        return 1
    if enc.returncode != 0:
        print("ERROR encoder failed", flush=True)
        return 1
    print("DONE", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 - report anything to Grimcut
        print(f"ERROR {type(e).__name__}: {e}", flush=True)
        sys.exit(1)
