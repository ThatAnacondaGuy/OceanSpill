"""WGS 84 transverse Mercator (UTM) forward and inverse projection, vectorised with numpy.

Series expansions from Snyder, "Map Projections: A Working Manual" (USGS PP 1395), accurate to
well under a metre within a UTM zone, which is far finer than SAR pixel spacing.
"""
from __future__ import annotations

import math

import numpy as np

A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)
EP2 = E2 / (1 - E2)
K0 = 0.9996
FALSE_EASTING = 500000.0


def central_meridian(zone: int) -> float:
    return -183.0 + 6.0 * zone


def _meridian_arc(phi: np.ndarray) -> np.ndarray:
    e4, e6 = E2 * E2, E2 * E2 * E2
    return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
                - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * np.sin(2 * phi)
                + (15 * e4 / 256 + 45 * e6 / 1024) * np.sin(4 * phi)
                - (35 * e6 / 3072) * np.sin(6 * phi))


def to_utm(lat, lon, zone: int, north: bool = True) -> tuple[np.ndarray, np.ndarray]:
    phi = np.radians(np.asarray(lat, dtype=np.float64))
    lam = np.radians(np.asarray(lon, dtype=np.float64) - central_meridian(zone))
    n = A / np.sqrt(1 - E2 * np.sin(phi) ** 2)
    t = np.tan(phi) ** 2
    c = EP2 * np.cos(phi) ** 2
    a = np.cos(phi) * lam
    m = _meridian_arc(phi)
    x = K0 * n * (a + (1 - t + c) * a**3 / 6 + (5 - 18 * t + t * t + 72 * c - 58 * EP2) * a**5 / 120) + FALSE_EASTING
    y = K0 * (m + n * np.tan(phi) * (a * a / 2 + (5 - t + 9 * c + 4 * c * c) * a**4 / 24
                                     + (61 - 58 * t + t * t + 600 * c - 330 * EP2) * a**6 / 720))
    if not north:
        y = y + 10_000_000.0
    return x, y


def from_utm(x, y, zone: int, north: bool = True) -> tuple[np.ndarray, np.ndarray]:
    x = np.asarray(x, dtype=np.float64) - FALSE_EASTING
    y = np.asarray(y, dtype=np.float64) - (0.0 if north else 10_000_000.0)
    m = y / K0
    mu = m / (A * (1 - E2 / 4 - 3 * E2**2 / 64 - 5 * E2**3 / 256))
    e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * np.sin(2 * mu)
            + (21 * e1**2 / 16 - 55 * e1**4 / 32) * np.sin(4 * mu)
            + (151 * e1**3 / 96) * np.sin(6 * mu)
            + (1097 * e1**4 / 512) * np.sin(8 * mu))
    n1 = A / np.sqrt(1 - E2 * np.sin(phi1) ** 2)
    t1 = np.tan(phi1) ** 2
    c1 = EP2 * np.cos(phi1) ** 2
    r1 = A * (1 - E2) / (1 - E2 * np.sin(phi1) ** 2) ** 1.5
    d = x / (n1 * K0)
    lat = phi1 - (n1 * np.tan(phi1) / r1) * (d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d**4 / 24
                                             + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d**6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d**3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d**5 / 120) / np.cos(phi1)
    return np.degrees(lat), central_meridian(zone) + np.degrees(lon)
