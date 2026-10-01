# stt_server.py — 常驻语音识别服务（stdin/stdout JSON 行协议）
# 启动后加载 faster-whisper small 模型一次，之后每行一个请求：
#   请求: {"id": <n>, "wav": "<绝对路径.wav>"}
#   响应: {"id": <n>, "ok": true, "text": "..."} / {"id": <n>, "ok": false, "error": "..."}
# 生命周期事件: {"event": "fallback", "to": "cpu"} / {"event": "ready"}
import sys, os, json

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")  # HuggingFace 走国内镜像
os.environ["HF_HUB_DISABLE_XET"] = "1"  # hf-mirror 不支持 Xet 存储，强制传统 HTTP 下载
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

MODEL_NAME = "small"  # 460MB，中文够用；CPU int8 也能跑


def log(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def pick_model():
    from faster_whisper import WhisperModel
    model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "whisper_models")
    os.makedirs(model_dir, exist_ok=True)
    # 默认 CPU int8：稳定且不挤游戏显存（本机缺 cublas/cudnn DLL，装了也占 1GB 显存）
    # 想用 GPU：pip install nvidia-cublas-cu12 nvidia-cudnn-cu12，并把下面顺序换回 cuda 优先
    for kwargs in (
        {"device": "cpu", "compute_type": "int8"},
        {"device": "cuda", "compute_type": "int8_float16"},
    ):
        try:
            m = WhisperModel(MODEL_NAME, download_root=model_dir, **kwargs)
            log({"event": "using_device", "device": kwargs["device"]})
            return m
        except Exception as e:
            log({"event": "fallback", "device": kwargs["device"], "err": str(e)[:200]})
    raise RuntimeError("no usable device for whisper")


model = pick_model()
log({"event": "ready"})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue
    try:
        segments, info = model.transcribe(
            req["wav"], language="zh", beam_size=1, vad_filter=True,
            initial_prompt="Minecraft 游戏中的语音指令，常涉及：橡树、白桦树、砍树、挖矿、石头、铁矿、钻石、跟随、攻击、回家、睡觉、吃东西。",
        )
        text = "".join(s.text for s in segments).strip()
        log({"id": req.get("id"), "ok": True, "text": text})
    except Exception as e:
        log({"id": req.get("id"), "ok": False, "error": str(e)[:300]})
