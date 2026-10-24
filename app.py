"""
3D dancing skeleton - Flask backend.

  python app.py            real webcam + MediaPipe
  python app.py --demo     synthetic dancing pose (no camera / no mediapipe needed)

The backend only measures your body (MediaPipe) and streams 3D landmarks to the
browser at /stream. The browser (three.js) builds and animates the anatomical skeleton.

Requires:  pip install flask opencv-python "numpy<2" mediapipe==0.10.21
"""
import argparse
import json
import math
import threading
import time

from flask import Flask, Response, render_template

app = Flask(__name__)

# ------------------------- SETTINGS -------------------------
CAMERA_INDEX     = 0
FRAME_W, FRAME_H = 960, 540
POSE_COMPLEXITY  = 1        # 0 lite | 1 full | 2 heavy
USE_FINGERS      = True     # also run the Hands model (3D finger bones)
PREVIEW_W        = 320      # width of the small camera preview
# ------------------------------------------------------------


def r4(v):
    return round(float(v), 4)


def build_payload(pres, hres, w, h, st):
    """MediaPipe results -> JSON-able dict in THREE.js space (metres, y up, mirrored)."""
    if not pres.pose_world_landmarks or not pres.pose_landmarks:
        return {"pose": None}

    wl = pres.pose_world_landmarks.landmark
    nl = pres.pose_landmarks.landmark
    # MediaPipe world: x right, y DOWN, z toward camera is negative.  Mirror view -> (-x, -y, -z)
    pose = [[r4(-p.x), r4(-p.y), r4(-p.z), r4(p.visibility)] for p in wl]

    # global position: where the hips are in the image, in metres (shoulder width gives the scale)
    sw_m = math.dist((wl[11].x, wl[11].y, wl[11].z), (wl[12].x, wl[12].y, wl[12].z))
    sw_px = math.hypot((nl[11].x - nl[12].x) * w, (nl[11].y - nl[12].y) * h)
    mpp = sw_m / max(sw_px, 1.0)
    hx = (nl[23].x + nl[24].x) / 2
    hy = (nl[23].y + nl[24].y) / 2
    st["hy_avg"] = hy if st.get("hy_avg") is None else st["hy_avg"] * 0.98 + hy * 0.02   # slow baseline
    root = [r4(-(hx - 0.5) * w * mpp), r4(-(hy - st["hy_avg"]) * h * mpp)]               # x absolute, y = jumps only

    hands = {"LEFT": None, "RIGHT": None}
    if hres is not None and hres.multi_hand_landmarks and hres.multi_hand_world_landmarks:
        for side, widx in (("LEFT", 15), ("RIGHT", 16)):
            wr = nl[widx]
            best, best_d = None, 0.15
            for hl, hwl in zip(hres.multi_hand_landmarks, hres.multi_hand_world_landmarks):
                d = math.hypot(hl.landmark[0].x - wr.x, hl.landmark[0].y - wr.y)
                if d < best_d:
                    best, best_d = hwl, d
            if best is not None:
                w0 = best.landmark[0]
                bx, by, bz = pose[widx][:3]            # hand is moved so its wrist sits on the pose wrist
                hands[side] = [[r4(bx - (p.x - w0.x)), r4(by - (p.y - w0.y)), r4(bz - (p.z - w0.z))]
                               for p in best.landmark]
    return {"pose": pose, "root": root, "hands": hands}


class Hub:
    """Latest data shared between the producer thread and the web streams."""
    def __init__(self):
        self.cond = threading.Condition()
        self.seq = 0
        self.json = None
        self.jpeg = None

    def publish(self, payload, jpeg=None):
        with self.cond:
            self.json = json.dumps(payload, separators=(",", ":"))
            if jpeg is not None:
                self.jpeg = jpeg
            self.seq += 1
            self.cond.notify_all()


hub = Hub()


def run_camera(args):
    import cv2
    import mediapipe as mp
    mp_pose, mp_hands = mp.solutions.pose, mp.solutions.hands
    pose = mp_pose.Pose(model_complexity=args.complexity, smooth_landmarks=True,
                        min_detection_confidence=0.6, min_tracking_confidence=0.6)
    hands = mp_hands.Hands(max_num_hands=2, model_complexity=1,
                           min_detection_confidence=0.6, min_tracking_confidence=0.6) if args.fingers else None
    cap = cv2.VideoCapture(args.camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_H)
    if not cap.isOpened():
        print("ERROR: could not open the camera (index %d)" % args.camera)
        return
    st, prev, fps = {}, time.time(), 0.0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        h, w, _ = frame.shape
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)          # models run on the UNFLIPPED frame
        rgb.flags.writeable = False
        pres = pose.process(rgb)
        hres = hands.process(rgb) if hands else None

        now = time.time()
        fps = 0.9 * fps + 0.1 / max(now - prev, 1e-3)
        prev = now
        payload = build_payload(pres, hres, w, h, st)
        payload["fps"] = round(fps)

        small = cv2.resize(cv2.flip(frame, 1), (PREVIEW_W, int(PREVIEW_W * h / w)))
        _, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
        hub.publish(payload, buf.tobytes())


# ----------------------------- demo mode -----------------------------
def run_demo(_args):
    import numpy as np
    try:
        import cv2
        img = np.full((180, 320, 3), (30, 24, 20), np.uint8)
        cv2.putText(img, "DEMO MODE", (70, 100), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (200, 220, 255), 2)
        hub.publish({"pose": None}, cv2.imencode(".jpg", img)[1].tobytes())
    except Exception:
        pass

    base = {0: (0, .70, .10), 2: (-.03, .73, .085), 5: (.03, .73, .085), 7: (-.075, .72, 0), 8: (.075, .72, 0),
            9: (-.025, .665, .085), 10: (.025, .665, .085), 11: (-.19, .5, 0), 12: (.19, .5, 0),
            23: (-.09, 0, 0), 24: (.09, 0, 0)}
    upper = {0, 2, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22}

    def arm(sh, side, a, b):             # a = upper-arm angle (0 = hanging, pi = overhead), b = forearm angle
        e = (sh[0] + side * 0.30 * math.sin(a), sh[1] - 0.30 * math.cos(a), 0.03)
        wr = (e[0] + side * 0.27 * math.sin(b), e[1] - 0.27 * math.cos(b), 0.08)
        return e, wr

    t0 = time.time()
    while True:
        t = time.time() - t0
        P = {i: [0.0, 0.0, 0.0] for i in range(33)}
        for i, v in base.items():
            P[i] = list(v)
        bend = 0.04 * abs(math.sin(2 * t))
        for s, sg in ((0, -1), (1, 1)):                       # legs (small knee bend)
            hip = P[23 + s]
            P[25 + s] = [sg * 0.10, -0.45 + bend * 0.5, 0.03 + bend]
            P[27 + s] = [sg * 0.10, -0.88 + bend, 0.0]
            P[29 + s] = [sg * 0.10, -0.93 + bend, -0.05]
            P[31 + s] = [sg * 0.11, -0.95 + bend, 0.12]
        ra = max(0.0, math.sin(0.9 * t)) * 2.7                # right arm waves overhead
        la = 0.2 + 0.5 * (1 + math.sin(1.7 * t)) * 0.6         # left arm swings out
        for side, sh, idx, ang in ((1, P[12], (14, 16, 18, 20, 22), ra), (-1, P[11], (13, 15, 17, 19, 21), la)):
            e, wr = arm(sh, side, ang, ang + 0.5 * math.sin(3 * t))
            P[idx[0]], P[idx[1]] = list(e), list(wr)
            for k in idx[2:]:
                P[k] = [wr[0] + side * 0.03, wr[1] + 0.02, wr[2]]
        tw = 0.6 * math.sin(1.1 * t)                          # twist the upper body about the vertical axis
        for i in upper:
            x, y, z = P[i]
            P[i] = [x * math.cos(tw) + z * math.sin(tw), y, -x * math.sin(tw) + z * math.cos(tw)]
        pose = [[r4(P[i][0]), r4(P[i][1]), r4(P[i][2]), 1.0] for i in range(33)]
        hub.publish({"pose": pose, "root": [r4(0.5 * math.sin(0.6 * t)), r4(0.04 * abs(math.sin(2 * t)))],
                     "hands": {"LEFT": None, "RIGHT": None}, "fps": 30})
        time.sleep(1 / 30)


# ----------------------------- routes -----------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/stream")
def stream():
    def gen():
        last = -1
        while True:
            with hub.cond:
                hub.cond.wait_for(lambda: hub.seq != last, timeout=2)
                seq, data = hub.seq, hub.json
            if seq == last or data is None:
                yield ": keep-alive\n\n"
                continue
            last = seq
            yield "data: %s\n\n" % data
    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/video_feed")
def video_feed():
    def gen():
        last = -1
        while True:
            with hub.cond:
                hub.cond.wait_for(lambda: hub.seq != last, timeout=2)
                seq, jpg = hub.seq, hub.jpeg
            if seq == last or jpg is None:
                continue
            last = seq
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="synthetic pose, no camera")
    ap.add_argument("--camera", type=int, default=CAMERA_INDEX)
    ap.add_argument("--complexity", type=int, default=POSE_COMPLEXITY, choices=[0, 1, 2])
    ap.add_argument("--no-fingers", dest="fingers", action="store_false", default=USE_FINGERS)
    ap.add_argument("--port", type=int, default=5000)
    args = ap.parse_args()
    threading.Thread(target=run_demo if args.demo else run_camera, args=(args,), daemon=True).start()
    print("Open http://127.0.0.1:%d" % args.port)
    app.run(host="127.0.0.1", port=args.port, threaded=True, debug=False)
