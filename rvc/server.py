"""
Локальный сервер RVC-конвертации для Сукуно.

Слушает только 127.0.0.1. Модель загружается один раз при старте и держится в памяти.

  GET  /health   -> состояние сервера
  POST /convert  -> multipart: file=WAV + pitch, index_rate, protect, f0method
                    возвращает сконвертированный WAV

Безопасность: файл .pth — это pickle, поэтому он грузится ТОЛЬКО с torch.load(weights_only=True).
Библиотека rvc-python сама вызывает torch.load без этого флага, поэтому torch.load здесь
обёрнут: для файла нашей модели флаг принудительно включается, для остальных вызовов
(hubert/rmvpe внутри библиотеки) поведение не меняется.
"""

import argparse
import os
import sys
import threading
import time
import traceback

import torch

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TMP_DIR = os.path.join(BASE_DIR, "tmp")

_original_torch_load = torch.load
_model_path_abs = ""
_lock = threading.Lock()
_state = {
    "loaded": False,
    "model": "",
    "index": "",
    "device": "",
    "version": "",
    "sr": "",
    "error": "",
}


def log(message):
    print(f"[rvc] {message}", flush=True)


def guarded_torch_load(f, *args, **kwargs):
    """weights_only=True для файла модели, обычное поведение для остальных."""
    try:
        if _model_path_abs and os.path.abspath(str(f)) == _model_path_abs:
            kwargs["weights_only"] = True
            log("загружаю модель с weights_only=True (безопасный режим)")
    except Exception:
        pass
    return _original_torch_load(f, *args, **kwargs)


def read_checkpoint_header(path):
    """Читает version/sr из .pth безопасно (weights_only=True)."""
    try:
        ckpt = torch.load(path, map_location="cpu", weights_only=True)
        version = str(ckpt.get("version", "v2")) if isinstance(ckpt, dict) else "v2"
        sr = str(ckpt.get("sr", "")) if isinstance(ckpt, dict) else ""
        return version, sr
    except Exception as exc:
        log(f"не удалось прочитать заголовок модели ({exc}); считаю версию v2")
        return "v2", ""


def pick_device(requested):
    if requested:
        return requested
    if torch.cuda.is_available():
        return "cuda:0"
    log("CUDA недоступна — работаю на CPU, конвертация будет медленной")
    return "cpu:0"


def load_model(model_path, index_path, device):
    """Грузит модель в память один раз."""
    global _model_path_abs
    from rvc_python.infer import RVCInference

    _model_path_abs = os.path.abspath(model_path)
    version, sr = read_checkpoint_header(_model_path_abs)
    log(f"модель: {os.path.basename(_model_path_abs)} (version={version}, sr={sr or '?'})")
    if index_path:
        if os.path.isfile(index_path):
            log(f"индекс: {os.path.basename(index_path)}")
        else:
            log(f"ВНИМАНИЕ: индекс не найден ({index_path}), конвертация будет без него")
            index_path = ""

    started = time.time()
    rvc = RVCInference(device=device, models_dir=os.path.join(BASE_DIR, "models"))
    rvc.load_model(_model_path_abs, version=version, index_path=index_path)
    log(f"модель загружена за {time.time() - started:.1f} c на {device}")

    _state.update(
        {
            "loaded": True,
            "model": os.path.basename(_model_path_abs),
            "index": os.path.basename(index_path) if index_path else "",
            "device": device,
            "version": version,
            "sr": sr,
            "error": "",
        }
    )
    return rvc


def build_app(model_path, index_path, device):
    from fastapi import FastAPI, File, Form, UploadFile
    from fastapi.responses import JSONResponse, Response
    from contextlib import asynccontextmanager

    holder = {"rvc": None}

    @asynccontextmanager
    async def lifespan(_app):
        os.makedirs(TMP_DIR, exist_ok=True)
        device_used = pick_device(device)
        try:
            holder["rvc"] = load_model(model_path, index_path, device_used)
        except Exception as exc:
            traceback.print_exc()
            if "cuda" in device_used:
                log(f"не удалось поднять GPU ({exc}) — пробую CPU")
                _state["error"] = f"GPU недоступен: {exc}"
                try:
                    holder["rvc"] = load_model(model_path, index_path, "cpu:0")
                except Exception as exc2:
                    traceback.print_exc()
                    _state["error"] = str(exc2)
            else:
                _state["error"] = str(exc)
        yield

    app = FastAPI(title="Sukuno RVC", lifespan=lifespan)

    @app.get("/health")
    def health():
        return JSONResponse(
            {
                "ok": bool(_state["loaded"]),
                "loaded": bool(_state["loaded"]),
                "model": _state["model"],
                "index": _state["index"],
                "device": _state["device"],
                "version": _state["version"],
                "sr": _state["sr"],
                "error": _state["error"],
            }
        )

    @app.post("/convert")
    async def convert(
        file: UploadFile = File(...),
        pitch: int = Form(0),
        index_rate: float = Form(0.6),
        protect: float = Form(0.33),
        f0method: str = Form("rmvpe"),
    ):
        rvc = holder["rvc"]
        if rvc is None:
            return JSONResponse(
                {"ok": False, "error": _state["error"] or "модель не загружена"}, status_code=503
            )

        stamp = f"{int(time.time() * 1000)}-{os.getpid()}"
        in_path = os.path.join(TMP_DIR, f"in-{stamp}.wav")
        out_path = os.path.join(TMP_DIR, f"out-{stamp}.wav")
        try:
            payload = await file.read()
            with open(in_path, "wb") as handle:
                handle.write(payload)
            if len(payload) < 200:
                return JSONResponse({"ok": False, "error": "пустой аудиофайл"}, status_code=400)

            started = time.time()
            with _lock:
                rvc.set_params(
                    f0up_key=int(pitch),
                    index_rate=float(index_rate),
                    protect=float(protect),
                    f0method=str(f0method),
                )
                rvc.infer_file(in_path, out_path)
            elapsed = time.time() - started

            if not os.path.isfile(out_path):
                return JSONResponse({"ok": False, "error": "конвертация не дала результата"}, status_code=500)
            with open(out_path, "rb") as handle:
                result = handle.read()

            log(
                f"конвертация {len(payload) / 1024:.0f} КБ -> {len(result) / 1024:.0f} КБ "
                f"за {elapsed:.2f} c (pitch={pitch}, index_rate={index_rate}, protect={protect})"
            )
            return Response(
                content=result,
                media_type="audio/wav",
                headers={"X-RVC-Seconds": f"{elapsed:.3f}", "X-RVC-Device": _state["device"]},
            )
        except Exception as exc:
            traceback.print_exc()
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)
        finally:
            for path in (in_path, out_path):
                try:
                    os.remove(path)
                except OSError:
                    pass

    return app


def main():
    global _model_path_abs

    parser = argparse.ArgumentParser(description="Sukuno RVC server")
    parser.add_argument("--model", default=os.path.join(BASE_DIR, "models", "model.pth"))
    parser.add_argument("--index", default="")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5055)
    parser.add_argument("--device", default="")
    args = parser.parse_args()

    _model_path_abs = os.path.abspath(args.model)
    torch.load = guarded_torch_load

    if not os.path.isfile(args.model):
        print(f"[rvc] ФАТАЛЬНО: файл модели не найден: {args.model}", flush=True)
        sys.exit(2)

    app = build_app(args.model, args.index, args.device)

    import uvicorn

    log(f"сервер на http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
