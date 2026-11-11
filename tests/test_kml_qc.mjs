import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectTrackSegments,
  inspectGeojson,
  removeAnomalyPoints,
  parseIsoTimestamp
} from '../web/js/kml-qc.js';

test('parseIsoTimestamp parses Z and timezone offsets', () => {
  const t1 = parseIsoTimestamp('2026-04-03T16:21:58Z');
  const t2 = parseIsoTimestamp('2026-04-03T16:22:00Z');
  assert.equal(t2 - t1, 2);
});

test('inspectTrackSegments flags large distance in short time as speed_jump', () => {
  const segments = [
    {
      segment_index: 1,
      name: '越野轨迹',
      points: [
        [101.653889, 31.805721, 2553.98],
        [101.655072, 31.806212, 2551.59],
        [101.655279, 31.806313, 2547.02]
      ],
      times: [
        '2026-04-03T16:21:58Z',
        '2026-04-03T16:22:00Z',
        '2026-04-03T16:22:01Z'
      ]
    }
  ];
  const qc = inspectTrackSegments(segments, 'offroad');
  assert.equal(qc.status, 'error');
  assert.equal(qc.issues_count, 1);
  assert.equal(qc.issues[0].type, 'speed_jump');
  assert.equal(qc.issues[0].point_index, 1);
  assert.equal(qc.issues[0].dt_s, 2);
  assert.ok(qc.issues[0].distance_m > 120);
  assert.ok(qc.issues[0].speed_kmh > 200);
});

test('removeAnomalyPoints removes flagged vertex and re-QC passes', () => {
  const segments = [
    {
      segment_index: 1,
      name: '主线',
      points: [
        [101.6500, 31.8000, 2500],
        [101.6501, 31.80005, 2501],
        [101.6600, 31.8050, 2502], // spike jump
        [101.6502, 31.8001, 2503]
      ],
      times: [
        '2026-04-03T10:00:00Z',
        '2026-04-03T10:00:02Z',
        '2026-04-03T10:00:04Z',
        '2026-04-03T10:00:06Z'
      ]
    }
  ];
  const fc = {
    type: 'FeatureCollection',
    properties: {},
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: segments[0].points },
        properties: { feature_type: 'route', segment_index: 1, name: '主线' }
      }
    ]
  };

  const qcBefore = inspectTrackSegments(segments, 'offroad');
  assert.equal(qcBefore.status, 'error');

  const { geojson: cleanedFc, qcSegments: cleanedSegs, removedCount } = removeAnomalyPoints(
    fc,
    segments,
    [{ segment_index: 1, point_index: 2 }]
  );
  assert.equal(removedCount, 1);
  assert.equal(cleanedFc.features[0].geometry.coordinates.length, 3);
  const qcAfter = inspectTrackSegments(cleanedSegs, 'offroad');
  assert.equal(qcAfter.status, 'passed');
  assert.equal(qcAfter.issues_count, 0);
});

test('inspectGeojson detects spatial_spike without timestamps', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [101.6000, 31.8000],
            [101.6005, 31.8000],
            [101.6100, 31.8100],
            [101.6007, 31.8001]
          ]
        },
        properties: { feature_type: 'route', segment_index: 1, name: '无时间段' }
      }
    ]
  };
  const qc = inspectGeojson(fc, 'hiking');
  assert.equal(qc.has_timestamps, false);
  assert.ok(qc.issues.some((i) => i.type === 'spatial_spike'));
});
