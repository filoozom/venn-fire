// Lower published confidence is paler and more transparent in both renderers.
export const FIRMS_CONFIDENCE_STYLE = {
  high: { color: '#c2321f', weight: 0.9, opacity: 0.80, fillOpacity: 0.30 },
  nominal: { color: '#e07a4b', weight: 0.7, opacity: 0.45, fillOpacity: 0.15 },
  low: { color: '#e8b48c', weight: 0.6, opacity: 0.28, fillOpacity: 0.07 },
  unknown: { color: '#c9b8a8', weight: 0.5, opacity: 0.22, fillOpacity: 0.05 },
}
