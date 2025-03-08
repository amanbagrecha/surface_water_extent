function computeSurfaceWaterAreaJRC(waterbody, start, stop, scale) {
  
  var geom = ee.Feature(waterbody).geometry().buffer(100)

  var jrcMonthly = ee.ImageCollection("JRC/GSW1_4/MonthlyHistory")
  var water = jrcMonthly.filterDate(start, stop).map(function(i) {
    var area = ee.Image.pixelArea().mask(i.eq(2)).reduceRegion({
      reducer: ee.Reducer.sum(), 
      geometry: geom, 
      scale: scale,
      crs: "EPSG:32643"
    })

    return i.set({area: area.get('area')})
  })

  return water
}

// var reservoir = ee.FeatureCollection("projects/ee-aciwrmgee/assets/reservoirVolume/Major_Reservoir_Karnataka")



var start = "2012-01-01"
var stop =  "2022-01-01"
var scale = 30

function analyzeWaterExtent(feature){
  
  
  var water = computeSurfaceWaterAreaJRC(feature, start, stop, scale)
  water = water.filter(ee.Filter.neq('area', 0));
  
  var water_agg = water.aggregate_array('area')


  return ee.Feature(null, {
    "objectid": feature.get("objectid"),
    "setname": feature.get("setname"),
    'reservoir_name': feature.get("wbname"),
  'areas': water.aggregate_array('area'),
  'month':water.aggregate_array('month'),
  'year':water.aggregate_array('year')
});

}

var geom = reservoir.filter(ee.Filter.eq('objectid', 56144));
var processedImages = ee.FeatureCollection(geom).map(analyzeWaterExtent)


Map.centerObject(geom, 12)
// print(processedImages)


Export.table.toDrive({
  collection: processedImages  ,
  description: 'JRC_surface_water_extent_2012_2020',
  fileFormat: 'CSV',
});
