"""Fixed Edge TTS helper: JSON on stdin, PCM WAV bytes on stdout."""

import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import wave

MAX_AUDIO_BYTES = 5 * 1024 * 1024
VOICES = {"zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural"}


class VoiceError(Exception):
    pass


def read_request():
    payload = sys.stdin.buffer.read(16385)
    if len(payload) > 16384:
        raise VoiceError("invalid_request")
    try:
        request = json.loads(payload.decode("utf-8"))
    except (UnicodeError, ValueError):
        raise VoiceError("invalid_request") from None
    if not isinstance(request, dict) or set(request) - {"text", "voice"}:
        raise VoiceError("invalid_request")
    text = request.get("text")
    voice = request.get("voice", "zh-CN-XiaoxiaoNeural")
    if not isinstance(text, str) or not text.strip() or len(text.strip()) > 200:
        raise VoiceError("invalid_request")
    if not isinstance(voice, str) or voice not in VOICES:
        raise VoiceError("invalid_request")
    return text.strip(), voice


def find_ffmpeg():
    executable = shutil.which("ffmpeg")
    if executable:
        return executable
    fallback = Path(__file__).resolve().parents[3] / "media-runtime" / "bin" / "ffmpeg.exe"
    if fallback.is_file():
        return str(fallback)
    raise VoiceError("missing_ffmpeg")


async def download_speech(edge_tts, text, voice, destination):
    proxy = os.environ.get("QQ_AGENT_SPEECH_PROXY") or os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or None
    communicate = edge_tts.Communicate(text=text, voice=voice, proxy=proxy)
    size = 0
    with destination.open("wb") as output:
        async for chunk in communicate.stream():
            if chunk.get("type") != "audio":
                continue
            data = chunk["data"]
            size += len(data)
            if size > MAX_AUDIO_BYTES:
                raise VoiceError("audio_too_large")
            output.write(data)
    if size == 0:
        raise VoiceError("tts_failed")


def synthesize(text, voice):
    ffmpeg = find_ffmpeg()
    try:
        import edge_tts
    except ImportError:
        raise VoiceError("missing_dependency") from None

    with tempfile.TemporaryDirectory(prefix="qq-agent-voice-") as temporary:
        mp3_path = Path(temporary) / "speech.mp3"
        wav_path = Path(temporary) / "speech.wav"
        try:
            asyncio.run(asyncio.wait_for(download_speech(edge_tts, text, voice, mp3_path), timeout=40))
        except TimeoutError:
            raise VoiceError("timeout") from None
        except VoiceError:
            raise
        except Exception:
            raise VoiceError("tts_failed") from None
        try:
            subprocess.run(
                [ffmpeg, "-nostdin", "-y", "-loglevel", "error", "-i", str(mp3_path),
                 "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le",
                 "-fs", str(MAX_AUDIO_BYTES + 1), str(wav_path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired:
            raise VoiceError("timeout") from None
        except (OSError, subprocess.SubprocessError):
            raise VoiceError("ffmpeg_failed") from None
        if not wav_path.is_file() or wav_path.stat().st_size <= 44:
            raise VoiceError("invalid_audio")
        if wav_path.stat().st_size > MAX_AUDIO_BYTES:
            raise VoiceError("audio_too_large")
        try:
            with wave.open(str(wav_path), "rb") as audio:
                if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 24000 or audio.getnframes() <= 0:
                    raise VoiceError("invalid_audio")
        except (wave.Error, EOFError):
            raise VoiceError("invalid_audio") from None
        return wav_path.read_bytes()


def main():
    try:
        text, voice = read_request()
        audio = synthesize(text, voice)
        sys.stdout.buffer.write(audio)
        sys.stdout.buffer.flush()
        return 0
    except VoiceError as error:
        sys.stderr.write("VOICE_ERROR:" + str(error) + "\n")
    except Exception:
        # Neither tracebacks nor local paths are part of the helper protocol.
        sys.stderr.write("VOICE_ERROR:tts_failed\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
