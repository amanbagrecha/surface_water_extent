var reservoir = ee.FeatureCollection("projects/ee-amanbagrecha/assets/waterbodies_frl");

function applyAdvancedCloudMask(image) {
  var fmask = image.select('Fmask');
  var cloudMask = fmask.bitwiseAnd(1 << 1).neq(0);
  var shadowMask = fmask.bitwiseAnd(1 << 3).neq(0);
  var cirrusMask = fmask.bitwiseAnd(1).neq(0);
  var aerosolMask = fmask.bitwiseAnd(3 << 6).eq(3 << 6);
  var combinedMask = cloudMask.or(shadowMask).or(cirrusMask).or(aerosolMask);
  
  var total_count = fmask.reduceRegion({
    reducer: ee.Reducer.count(),
    geometry: geom,
    bestEffort: true,
    scale: 30
  }).values().get(0);
  
  var invalid_count = fmask.mask(combinedMask).not().reduceRegion({
    reducer: ee.Reducer.count(),
    geometry: geom,
    bestEffort: true,
    scale: 30
  }).values().get(0);
  
  var invalid_percentage = ee.Number(invalid_count).divide(total_count);
  return image.set({"invalid_percentage": invalid_percentage});
}

function filterCompleteCoverage(image, geometry) {
  var intersection = image.geometry().intersection(geometry, ee.ErrorMargin(1));
  var intersectionArea = intersection.area();
  var aoiArea = geometry.area();
  var coveragePercentage = intersectionArea.divide(aoiArea).multiply(100);
  var coversAoi = coveragePercentage.gte(99);
  return image.set('coversAoi', coversAoi);
}

function mosaicByDate(imcol) {
  var imlist = imcol.toList(imcol.size());
  var unique_dates = imlist.map(function(im) {
    return ee.Image(im).date().format("YYYY-MM-dd");
  }).distinct();
  
  var mosaic_imlist = unique_dates.map(function(d) {
    d = ee.Date(d);
    var im = imcol.filterDate(d, d.advance(1, "day"));
    var imm = im.mosaic();
    imm = imm.set("system:footprint", im.geometry());
    return imm.set("system:time_start", d.millis(), "system:id", d.format("YYYY-MM-dd"));
  });
  
  return ee.ImageCollection(mosaic_imlist);
}

function calculateNDWI_landsat(image) {
  var ndwi = image.normalizedDifference(['B3', 'B6']).rename('NDWI');
  return image.addBands(ndwi);
}

var featureCol = reservoir.filter(ee.Filter.eq('objectid', 56144));
var geom = featureCol.first().geometry().buffer(100);

var collection = ee.ImageCollection("NASA/HLS/HLSL30/v002")
                .filter(ee.Filter.date('2019-10-01', '2019-12-28'))
                .filter(ee.Filter.lt('CLOUD_COVERAGE', 95))
                .filterBounds(geom)
                .map(applyAdvancedCloudMask)
                .filter(ee.Filter.gte('invalid_percentage', 0.97))
                .map(function(img) { return filterCompleteCoverage(img, geom); })
                .filter(ee.Filter.eq('coversAoi', 1))
                .map(calculateNDWI_landsat);

var metrics = collection.map(function(image) {
  var th = -0.01;
  var water = image.select("NDWI").gt(th);
  var surface_area = ee.Image.pixelArea().mask(water)
    .reduceRegion({
      reducer: ee.Reducer.sum(),
      geometry: geom,
      scale: 30,
      maxPixels: 1e13
    }).get('area');
  return image.set({
    'date': image.date().format('YYYY-MM-dd'), 
    'area': surface_area
  });
});

var singlePolygonCollection = metrics.map(function(image) {
  var th = -0.01;
  var water = image.select("NDWI").gt(th);
  var waterVector = water.reduceToVectors({
    geometry: geom,
    reducer: ee.Reducer.countEvery(),
    scale: 30,
    eightConnected: true,
    maxPixels: 1e13
  });
  
  var date = image.get("date");
  waterVector = waterVector.filter(ee.Filter.eq('label', 1));
  
  return waterVector.map(function(fea) {
    return fea.set('date', date);
  });
}).flatten();

Map.addLayer(featureCol, {color: 'red'}, 'Reservoir Feature');
Map.centerObject(featureCol, 12);

// Get unique dates from the feature collection.
var uniqueDates = ee.List(singlePolygonCollection.aggregate_array('date')).distinct();

// For each date, merge the geometries and compute the total area with a specified error margin.
var mergedByDate = ee.FeatureCollection(uniqueDates.map(function(d) {
  d = ee.String(d);
  var featuresByDate = singlePolygonCollection.filter(ee.Filter.eq('date', d));
  var mergedGeom = featuresByDate.geometry();
  var mergedArea = mergedGeom.area({maxError: 1});
  return ee.Feature(mergedGeom, {'date': d, 'merged_area': mergedArea});
}));

print("Merged Geometry Timeseries", mergedByDate);
// Map.addLayer(mergedByDate, {color: 'blue'}, 'Merged Geometry per Date');
