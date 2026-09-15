from oceanspill.coast_osm import Box, CoastLand, clip_chain, close_pieces, join_ways, signed_area, simplify
from oceanspill.geometry import keep_at_sea, reported_geometry
from oceanspill.providers.ais_synthetic import LandMask

BOX = Box(80.0, 13.0, 80.5, 13.5)


def _way(way_id, nodes, coords):
    return {"id": way_id, "nodes": nodes, "geometry": [{"lon": x, "lat": y} for x, y in coords]}


def _straight_coast():
    """Coast along 80.3 E drawn northward, so land (on the left of travel) is to the west, as at Chennai."""
    ways = [
        _way(1, [1, 2], [(80.3, 12.9), (80.3, 13.25)]),
        _way(2, [2, 3], [(80.3, 13.25), (80.3, 13.6)]),
    ]
    chain = join_ways(ways)
    assert len(chain) == 1 and len(chain[0]) == 3
    pieces, rings = clip_chain(chain[0], BOX)
    assert not rings and len(pieces) == 1
    land = close_pieces(pieces, BOX)
    return CoastLand(BOX, land, pieces)


def test_open_coastline_closes_into_land_on_the_left():
    coast = _straight_coast()
    assert len(coast.rings) == 1
    # Land on the left of the coastline makes the closed land ring counter-clockwise.
    assert signed_area(coast.rings[0]) > 0
    assert coast.on_land(13.2, 80.1)
    assert not coast.on_land(13.2, 80.4)
    # Outside the box nothing is known, so it counts as water.
    assert not coast.on_land(14.0, 79.0)


def test_island_ring_inside_box_is_land():
    island = [(80.40, 13.10), (80.45, 13.10), (80.45, 13.15), (80.40, 13.15), (80.40, 13.10)]
    pieces, rings = clip_chain(island, BOX)
    assert not pieces and len(rings) == 1
    coast = CoastLand(BOX, rings, [island])
    assert coast.on_land(13.12, 80.42) and not coast.on_land(13.3, 80.42)


def test_nearest_coast_point():
    coast = _straight_coast()
    lon, lat = coast.nearest_coast(13.2, 80.35)
    assert abs(lon - 80.3) < 1e-9 and abs(lat - 13.2) < 1e-9


def test_simplify_keeps_ends_and_drops_collinear_points():
    pts = [(0.0, 0.0), (0.5, 0.00001), (1.0, 0.0)]
    assert simplify(pts, 0.001) == [(0.0, 0.0), (1.0, 0.0)]


def test_reported_extent_strip_follows_coast_on_the_sea(reference, cases):
    case = cases["IND-2023-12-ENNORE-CREEK"]
    # Put the synthetic coast through the reported line so the old centred strip would straddle it.
    ext = next(o for o in case["observations"] if o.get("reportedExtent"))["reportedExtent"]
    lon = (ext["from"]["lon"] + ext["to"]["lon"]) / 2
    box = Box(lon - 0.3, 12.9, lon + 0.3, 13.4)
    pieces, _ = clip_chain([(lon, 12.8), (lon, 13.5)], box)
    coast = CoastLand(box, close_pieces(pieces, box), pieces)
    geom = reported_geometry(case, LandMask(reference[0]), coast)
    assert not any(coast.on_land(p["lat"], p["lon"]) for p in geom["ring"])
    assert all(p["lon"] > lon for p in geom["ring"])
    assert any("coastline" in a for a in geom["assumptions"])
    assert not any("could not be determined" in a for a in geom["assumptions"])


def test_keep_at_sea_moves_inland_vertices_to_the_shore():
    coast = _straight_coast()
    ring = [{"lat": 13.2, "lon": 80.25}, {"lat": 13.2, "lon": 80.4}, {"lat": 13.3, "lon": 80.4}]
    out, moved = keep_at_sea(ring, coast)
    assert moved
    assert not any(coast.on_land(p["lat"], p["lon"]) for p in out)
    assert abs(out[0]["lon"] - 80.3) < 0.01
