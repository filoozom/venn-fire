# Reproducible timeline video

The timeline renderer opens the real viewer in Chromium, selects each five-minute incident frame, takes a viewport screenshot, and streams the PNG directly into FFmpeg. The default result is a 1920 × 1080 H.264 MP4 containing the full incident timeline from its first frame through the latest frame available when rendering begins.

It deliberately uses the website's own rendering code. The map, best-estimate outline, precipitation radar, FIRMS detections, Sentinel layers, aircraft, wind observations, panels, labels, and every other layer enabled by default therefore match the viewer. The renderer does not invent intermediate states or interpolate data between the website's five-minute frames.

## Requirements

- Node.js and the repository dependencies (`pnpm install`)
- Playwright Chromium (`pnpm exec playwright install chromium`)
- FFmpeg with an H.264 encoder (`ffmpeg -encoders | grep libx264`)

## Render the complete timeline

```bash
pnpm video:timeline -- --output output/venn-fire-full-timeline.mp4
```

The default settings capture every five-minute website frame at 1920 × 1080, encode at 30 fps, hold the opening for one second, and hold the latest frame for two seconds. Around four days of incident history produces roughly 1,150 screenshots and a video of about 41 seconds.

The script writes `output/venn-fire-full-timeline.mp4.json` beside the MP4. That sidecar records the exact frozen database time, deployed Git SHA when available, timeline timestamps and frame indexes, selected layers, viewport, frame rate, and FFmpeg settings.

## Why the data is frozen

The first `core` and `aircraft` database responses are retained in the browser route and replayed if the viewer refreshes while rendering. This prevents the timeline from growing or changing partway through a video. Map tiles and immutable database image IDs still load normally. Use `--no-freeze-data` only when a moving live snapshot is intentional.

## Configure a render

Copy [timeline-video.config.example.json](../timeline-video.config.example.json), change it, and pass it to the renderer:

```bash
cp timeline-video.config.example.json timeline-video.config.json
pnpm video:timeline -- --config timeline-video.config.json
```

The `layers` object uses the exact visible layer labels from the left sidebar. Entries override the website defaults; omitted layers keep their normal default state. For example:

```json
{
  "baseMap": "satellite",
  "layers": {
    "Precipitation radar": false,
    "NASA VIIRS false colour": true,
    "CAMS PM2.5 model": true
  }
}
```

The same changes can be made without a config file:

```bash
pnpm video:timeline -- \
  --base-map satellite \
  --layer "Precipitation radar=off" \
  --layer "NASA VIIRS false colour=on"
```

Useful timing controls are:

- `frameStep`: capture every Nth five-minute frame. `1` preserves the website's full granularity; `2` captures every ten minutes.
- `fps`: video playback frame rate.
- `holdFrames`: repeat every captured screenshot to slow playback without dropping source frames.
- `introSeconds` and `outroSeconds`: readable holds on the first and final states.
- `startFrame` / `endFrame`: inclusive timeline indexes.
- `startTime` / `endTime`: ISO timestamps with a timezone, such as `2026-08-15T08:00:00+02:00`.
- `settleMs`: extra time for React, Leaflet and the browser compositor after changing frames.
- `assetTimeoutMs`: maximum wait for each visible Leaflet raster. A timeout fails the render instead of silently encoding the preceding radar frame.

Run `pnpm video:timeline -- --help` for every command-line override.

## News presentation

The `news` presentation removes the application header, sidebars, map controls,
warning card and detailed timeline controls. It expands the map to the full
1920 × 1080 canvas, focuses on the fire, and retains a clean timeline plus a
large day/time card. Its broadcast overlay shows announced and derived area,
the speed-weighted wind-vector mean from the two nearest current weather
stations (the model grid is excluded), and the latest sourced incident updates:

```bash
pnpm video:timeline -- \
  --presentation news \
  --output output/venn-fire-news-timeline.mp4
```

All website-default data layers remain unchanged. Use `mapFocus` or
`--map-focus` to select the full incident extent instead, and `mapZoomSteps` or
`--map-zoom-steps` for additional zoom after the initial fit. The rolling feed
shows five entries by default; change it with `newsFeedItems` or
`--news-feed-items`. Every update enters the feed at its timeline timestamp,
and the header reports the complete number visible by that time.

The news layout removes only Leaflet's optional branding prefix. Required map,
radar and data-provider attribution remains visible in a compact strip aligned
above the timeline.

The same presentation is available as a live database-backed browser view:

```text
https://venn-fire.vercel.app/?presentation=news
```

The range remains draggable and the compact play button restarts from the
incident beginning when the page is at the latest frame. Append `&updates=8`
to show up to eight rolling feed entries; the default is five and the supported
range is one to ten.

Preview the final selected frame without starting FFmpeg or encoding a video:

```bash
pnpm video:timeline -- \
  --presentation news \
  --preview-output output/news-preview.png
```

## Output and repeatability

The browser viewport is the encoded frame: it is not resized after capture. Width and height must be even because the output uses broadly compatible `yuv420p` colour sampling. Existing outputs are protected by default; use `--overwrite` deliberately to replace them.

The MP4 is operationally reproducible rather than guaranteed byte-identical. Remote base-map tiles can change, and FFmpeg/Chromium versions can alter compression or font rasterization. The JSON sidecar preserves the material inputs needed to explain or recreate a render.
