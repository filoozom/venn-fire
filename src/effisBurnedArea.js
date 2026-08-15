// Copernicus EFFIS feature effis.nrt.ba.poly.15626430, queried from the
// official WFS for 2026-08-14. EFFIS generates this near-real-time footprint
// automatically from VIIRS active-fire detections. It is a daily reference
// layer, not a field-surveyed incident perimeter or a five-minute time series.
const effisBurnedArea20260814 = {
  featureId: 'effis.nrt.ba.poly.15626430',
  productDate: '2026-08-14',
  productLabel: '14 Aug 2026 daily product',
  retrievedAt: '2026-08-15T02:47:29.603Z',
  source: 'Copernicus EFFIS',
  sourceEndpoint: 'https://maps.effis.emergency.copernicus.eu/effis',
  sourceRequestUrl: 'https://maps.effis.emergency.copernicus.eu/effis?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=ms%3Aeffis.nrt.ba.poly&SRSNAME=EPSG%3A4326&OUTPUTFORMAT=geojson&TIME=2026-08-14&BBOX=50.45%2C5.9%2C50.7%2C6.25%2CEPSG%3A4326',
  sourceUrl: 'https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/rapid-damage-assessment',
  sensor: 'VIIRS',
  nominalResolutionM: 375,
  areaHa: 501.4,
  areaMethod: 'Calculated locally from the published polygon geometry',
  labelPosition: [50.54914, 6.0881],
  // Leaflet uses latitude/longitude order. The second ring is a source hole.
  rings: [
    [
      [50.5270906, 6.0773866],
      [50.5270906, 6.0812134],
      [50.5289519, 6.0833550],
      [50.5272906, 6.0855666],
      [50.5272781, 6.0893306],
      [50.5243206, 6.0920866],
      [50.5251502, 6.0971549],
      [50.5224806, 6.0998366],
      [50.5224806, 6.1036634],
      [50.5251866, 6.1063694],
      [50.5300598, 6.1056702],
      [50.5331166, 6.1104394],
      [50.5369434, 6.1104394],
      [50.5396494, 6.1077334],
      [50.5396100, 6.1019800],
      [50.5365234, 6.0973606],
      [50.5325084, 6.0974863],
      [50.5335719, 6.0921494],
      [50.5366182, 6.0889468],
      [50.5405634, 6.0885594],
      [50.5433013, 6.0856932],
      [50.5476755, 6.0843955],
      [50.5491400, 6.0808600],
      [50.5488794, 6.0745366],
      [50.5461734, 6.0718306],
      [50.5434216, 6.0716168],
      [50.5403734, 6.0671906],
      [50.5358436, 6.0676604],
      [50.5319700, 6.0656900],
      [50.5273506, 6.0687766],
      [50.5273506, 6.0726034],
      [50.5290955, 6.0746672],
      [50.5270906, 6.0773866],
    ],
    [
      [50.5310416, 6.0984937],
      [50.5309318, 6.0986579],
      [50.5308898, 6.0985951],
      [50.5310416, 6.0984937],
    ],
  ],
}

// Current-day EFFIS feature selected from the official WFS because its geometry
// contains the Drossart incident locality. The service returned geometry only:
// it did not include an acquisition timestamp or a field-validated area. Its
// calculated 4,857 ha geometry is therefore an algorithmic daily envelope and
// MUST NOT be presented as 4,857 burned or officially affected hectares.
const effisBurnedArea20260815 = {
  featureId: null,
  productDate: '2026-08-15',
  productLabel: '15 Aug 2026 daily product',
  retrievedAt: '2026-08-15T09:33:03.979Z',
  source: 'Copernicus EFFIS',
  sourceEndpoint: 'https://maps.effis.emergency.copernicus.eu/effis',
  sourceRequestUrl: 'https://maps.effis.emergency.copernicus.eu/effis?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=ms%3Aeffis.nrt.ba.poly&SRSNAME=EPSG%3A4326&OUTPUTFORMAT=geojson&TIME=2026-08-15&BBOX=50.45%2C5.9%2C50.7%2C6.25%2CEPSG%3A4326',
  sourceUrl: 'https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/rapid-damage-assessment',
  sensor: 'VIIRS',
  nominalResolutionM: 375,
  areaHa: 4857.041323095703,
  areaMethod: 'Calculated locally from the published polygon geometry',
  labelPosition: [50.531, 6.061],
  caveat: 'Automated daily VIIRS geometry; not an official affected-area estimate or field-surveyed perimeter',
  rings: [
    [
      [50.5084166, 6.0026906],
      [50.5053300, 6.0073100],
      [50.5082903, 6.0118450],
      [50.5053600, 6.0163600],
      [50.5084201, 6.0209617],
      [50.5057606, 6.0236366],
      [50.5057606, 6.0274634],
      [50.5084666, 6.0301694],
      [50.5139139, 6.0309040],
      [50.5079745, 6.0335345],
      [50.5065100, 6.0370700],
      [50.5079206, 6.0405249],
      [50.5054006, 6.0431066],
      [50.5054006, 6.0469334],
      [50.5102541, 6.0500506],
      [50.5084680, 6.0527635],
      [50.5048145, 6.0542045],
      [50.5033500, 6.0577400],
      [50.5069182, 6.0624552],
      [50.5033806, 6.0653266],
      [50.5042587, 6.0704675],
      [50.5026406, 6.0724466],
      [50.5014949, 6.0843439],
      [50.4977600, 6.0916800],
      [50.4987106, 6.0969734],
      [50.5019083, 6.1003040],
      [50.5000006, 6.1024766],
      [50.5005732, 6.1071604],
      [50.4980700, 6.1113900],
      [50.5011566, 6.1160094],
      [50.5065975, 6.1149309],
      [50.5076411, 6.1168971],
      [50.5046945, 6.1182445],
      [50.5011806, 6.1243266],
      [50.5022645, 6.1297755],
      [50.5077134, 6.1308594],
      [50.5107510, 6.1259935],
      [50.5148434, 6.1261594],
      [50.5175548, 6.1234263],
      [50.5166106, 6.1292234],
      [50.5202145, 6.1350955],
      [50.5237500, 6.1365600],
      [50.5272855, 6.1350955],
      [50.5293938, 6.1303961],
      [50.5366800, 6.1329200],
      [50.5412994, 6.1298334],
      [50.5402155, 6.1243845],
      [50.5322469, 6.1214246],
      [50.5327050, 6.1160010],
      [50.5354694, 6.1132834],
      [50.5357136, 6.1106840],
      [50.5396494, 6.1077334],
      [50.5409716, 6.1028065],
      [50.5446755, 6.1013755],
      [50.5498694, 6.0957134],
      [50.5507810, 6.0868663],
      [50.5544866, 6.0898694],
      [50.5599355, 6.0887855],
      [50.5614000, 6.0852500],
      [50.5601044, 6.0819672],
      [50.5621400, 6.0780500],
      [50.5606755, 6.0745145],
      [50.5541756, 6.0723863],
      [50.5551048, 6.0678566],
      [50.5586300, 6.0631500],
      [50.5557262, 6.0586527],
      [50.5558594, 6.0546266],
      [50.5526557, 6.0518216],
      [50.5533294, 6.0469866],
      [50.5510016, 6.0445333],
      [50.5532794, 6.0421134],
      [50.5532794, 6.0382866],
      [50.5510264, 6.0358833],
      [50.5536100, 6.0316000],
      [50.5505234, 6.0269806],
      [50.5459499, 6.0271302],
      [50.5466694, 6.0222266],
      [50.5442668, 6.0197233],
      [50.5470000, 6.0153400],
      [50.5440596, 6.0108183],
      [50.5465694, 6.0082434],
      [50.5465694, 6.0044166],
      [50.5438634, 6.0017106],
      [50.5372098, 6.0020540],
      [50.5403700, 5.9974200],
      [50.5389055, 5.9938845],
      [50.5362651, 5.9925980],
      [50.5399194, 5.9897034],
      [50.5388355, 5.9842545],
      [50.5233000, 5.9822000],
      [50.5197645, 5.9836645],
      [50.5172600, 5.9881400],
      [50.5203362, 5.9927525],
      [50.5173300, 5.9975400],
      [50.5204198, 6.0021600],
      [50.5168400, 6.0015600],
      [50.5084166, 6.0026906],
    ],
    [[50.5129753, 6.0114404], [50.5139312, 6.0120791], [50.5133556, 6.0124637], [50.5129753, 6.0114404]],
    [[50.5140611, 6.0215323], [50.5136275, 6.0218220], [50.5123199, 6.0209483], [50.5140611, 6.0215323]],
    [[50.5198906, 6.0216470], [50.5187889, 6.0209177], [50.5194021, 6.0205080], [50.5198906, 6.0216470]],
    [[50.5198606, 6.0121270], [50.5188188, 6.0114309], [50.5205435, 6.0116707], [50.5198606, 6.0121270]],
    [[50.5255601, 6.0012796], [50.5268064, 6.0021124], [50.5265077, 6.0023120], [50.5255601, 6.0012796]],
    [[50.5265775, 5.9929220], [50.5252538, 5.9920375], [50.5255424, 5.9918446], [50.5265775, 5.9929220]],
    [[50.5260587, 6.0201160], [50.5267792, 6.0205974], [50.5263246, 6.0209341], [50.5260587, 6.0201160]],
    [[50.5331913, 6.0022980], [50.5319036, 6.0014376], [50.5335902, 6.0020660], [50.5331913, 6.0022980]],
    [[50.5322795, 5.9916696], [50.5344049, 5.9926120], [50.5331887, 5.9929796], [50.5322795, 5.9916696]],
    [[50.5374698, 6.0112350], [50.5389664, 6.0102343], [50.5398904, 6.0108517], [50.5384205, 6.0118702], [50.5374698, 6.0112350]],
  ],
}

export const effisBurnedAreas = [effisBurnedArea20260814, effisBurnedArea20260815]

// Retain the original export for code that needs the latest available product.
export const effisBurnedArea = effisBurnedArea20260815

// Belgium is UTC+2 for the whole incident window, and every timestamp in this
// project is expressed against that offset.
const LOCAL_UTC_OFFSET_MS = 2 * 60 * 60 * 1000

function localDayStartMs(productDate) {
  return Date.parse(`${productDate}T00:00:00+02:00`)
}

function localDateOf(timestampMs) {
  return new Date(timestampMs + LOCAL_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

export function effisAreaForTimestamp(timestampMs) {
  // Each product is EFFIS's daily footprint for its own product date, so it
  // becomes applicable at the start of that local day and stays visible until
  // the next product's day begins.
  //
  // This must never be gated on retrievedAt. That field records when we fetched
  // the file, not the period it describes, so gating on it pushed published data
  // later on the timeline every time the importer ran: the 15 August product
  // appeared only from 11:33 CEST purely because that is when the import
  // happened, and a later refresh would have delayed it further.
  let applicable = null
  for (const product of effisBurnedAreas) {
    if (timestampMs >= localDayStartMs(product.productDate)) applicable = product
  }

  // Before the first product's day, keep the earliest one rather than hiding the
  // layer. A blank would imply the fire had no footprint at all.
  return applicable ?? effisBurnedAreas[0]
}

/**
 * Whether the displayed product predates the day being viewed, meaning it is the
 * previous day's footprint held over because no product exists yet for this day.
 * A product shown on its own date is current, not carried forward.
 */
export function effisProductIsCarriedForward(product, timestampMs) {
  if (!product) return false
  return product.productDate < localDateOf(timestampMs)
}
