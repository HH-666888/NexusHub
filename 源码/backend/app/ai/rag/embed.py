"""本地字符 n-gram 哈希向量。

不依赖外部 embedding API；向量可复现，适合比赛环境的离线检索。
"""

from __future__ import annotations

import hashlib
import math
import re
import struct

DIM = 256
MODEL = "local-char-ngram-v1"


def _grams(text: str) -> list[str]:
    cleaned = re.sub(r"\s+", "", (text or "").lower())
    grams: list[str] = []
    for n in (2, 3):
        for i in range(max(0, len(cleaned) - n + 1)):
            grams.append(cleaned[i : i + n])
    return grams


def vector(text: str) -> list[float]:
    vec = [0.0] * DIM
    for gram in _grams(text):
        digest = hashlib.blake2b(gram.encode("utf-8"), digest_size=8).digest()
        index = int.from_bytes(digest[:4], "little") % DIM
        sign = 1.0 if digest[4] & 1 else -1.0
        vec[index] += sign
    norm = math.sqrt(sum(value * value for value in vec))
    if norm:
        vec = [value / norm for value in vec]
    return vec


def pack(text: str) -> bytes:
    return struct.pack("<" + "f" * DIM, *vector(text))


def unpack(blob: bytes) -> list[float]:
    if not blob or len(blob) != DIM * 4:
        return [0.0] * DIM
    return list(struct.unpack("<" + "f" * DIM, blob))


def cosine(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    return float(sum(a * b for a, b in zip(left, right)))
