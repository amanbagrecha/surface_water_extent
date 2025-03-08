
var reservoir = ee.FeatureCollection("projects/ee-aciwrmgee/assets/reservoirVolume/Major_Reservoir_Karnataka")

Map.addLayer(reservoir)
Map.centerObject(reservoir)

function showWaterbodyByFid(fid) {
  var selectedWaterbody = reservoir.filter(ee.Filter.eq('objectid', ee.Number.parse(fid)))
  Map.centerObject(selectedWaterbody)

  plotChart(selectedWaterbody)
  
}

var fidBox = ui.Panel({
  widgets: [
    ui.Textbox({ 
      placeholder: '<enter reservoir objectid>', 
      onChange: showWaterbodyByFid, 
      style: { width: '200px' } 
    })
  ],
  style: { position: 'bottom-left', padding: 0 }
})
Map.widgets().add(fidBox)

var panelCharts = ui.Panel({
  style: { position: 'bottom-right', padding: 0, width: '600px', height: '305px', shown:false }
})
Map.widgets().add(panelCharts)


function plotChart(clickedReservoir) {
  
    panelCharts.style().set({ shown: false })
    clickedReservoir.evaluate(function(featureCollection) {
    
    if (featureCollection.features.length > 0) {
      
      var selectedLayer = ui.Map.Layer(clickedReservoir.style({ color: 'yellow', fillColor: 'ffff0005'}), {}, 'selected image')

      if (Map.layers().length() > 1){
        Map.remove(Map.layers().get(1))
      }
        
      Map.layers().add(selectedLayer)

      var processedImages = ee.FeatureCollection(featureCollection).map(analyzeWaterExtent)
      // print(processedImages)
      processedImages.evaluate(function(result) {
        result.features.forEach(function(feature) {
          var geometryID = feature.properties.reservoir_name;
          var dates = feature.properties.dates;
          var areas = feature.properties.areas;
          print(areas)
          print(dates)
          // Create a chart
          var chart = ui.Chart.array.values({
            array: areas,
            axis: 0,
            xLabels: dates
          }).setOptions({
            title: 'Water Area over Time for ' + geometryID,
            hAxis: {title: 'Date'},
            vAxis: {title: 'Area (in square meters)'},
            lineWidth: 1,
            pointSize: 1,
            legend: {
              position: 'none'
            },
            backgroundColor: '#fff7fb',
            width: '700px', height: '290px',
          });
      

            panelCharts.add(chart)

            panelCharts.style().set({ shown: true })
        });
      });

    }}
)
}

Map.onClick(function(coords) {
  var point = ee.Geometry.Point([coords.lon, coords.lat]);
  var clickedReservoir = reservoir.filterBounds(point);
  panelCharts.clear();

  // panelCharts.add(ui.Label('No data (yet) ...'))
  plotChart(clickedReservoir)
});


function filterCompleteCoverage(image, geometry) {
    var intersection = image.geometry().intersection(geometry, ee.ErrorMargin(1));
    var intersectionArea = intersection.area();
    var aoiArea = geometry.area();
    
    var coveragePercentage = intersectionArea.divide(aoiArea).multiply(100);
    
    var coversAoi = coveragePercentage.gte(99)
    return image.set('coversAoi', coversAoi);
}


function calculateNDWI(image) {
  var ndwi = image.normalizedDifference(['B3', 'B8']).rename('NDWI'); // B3 (Green) and B8 (NIR)
  return image.addBands(ndwi);
}


function mosaicByDate(imcol){
  // imcol: An image collection
  // returns: An image collection
  var imlist = imcol.toList(imcol.size())

  var unique_dates = imlist.map(function(im){
    return ee.Image(im).date().format("YYYY-MM-dd")
  }).distinct()

  var mosaic_imlist = unique_dates.map(function(d){
    d = ee.Date(d)

    var im = imcol
      .filterDate(d, d.advance(1, "day"))
    
    var imm = im.mosaic()
    
    imm = imm.set("system:footprint", im.geometry())
    return imm.set(
        "system:time_start", d.millis(), 
        "system:id", d.format("YYYY-MM-dd"))
  })

  return ee.ImageCollection(mosaic_imlist)
}


function calculateInvalidPixels(image, geometry) {
  // Mask invalid pixels based on "vaMlid_scl_class" property
  var scl = image.select("SCL")
  var validMask = scl.eq(4).or(scl.eq(5)).or(scl.eq(6)).or(scl.eq(7));

  // Calculate the percentage of invalid pixels
  var total_count = scl.reduceRegion({
    reducer: ee.Reducer.count(),
    geometry: geometry,
    scale: 30
  }).values().get(0)
  var invalid_count = scl.mask(validMask).not().reduceRegion({
    reducer: ee.Reducer.count(),
    geometry:geometry,
    scale: 30
  }).values().get(0)
  
  var invalidPercentage = ee.Number(invalid_count).divide(total_count)

  // var date = ee.Date(image.get('system:time_start')).format('YYYY-MM-dd')
  return image.set({
    'invalid_percentage': invalidPercentage
  });
}

function analyzeWaterExtent(feature) {
  
  var feature_buffer = ee.Number(feature.get("st_area_sh")).sqrt().multiply(0.1)

  var polygonGeometry = feature.geometry().buffer(feature_buffer).simplify(500);


  var startDate = "2019-01-01";
  var endDate = "2024-04-30"//ee.Date(Date.now()); 
  // Load and preprocess Sentinel-2 ImageCollection
  var filteredCollection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterDate(startDate, endDate)
    .filterBounds(polygonGeometry)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE',90))
    
  filteredCollection = mosaicByDate(filteredCollection)
                      .map(function(img) {return filterCompleteCoverage(img, polygonGeometry) } )
                      .filter(ee.Filter.eq('coversAoi', 1))
                      .map(function(img) {return calculateInvalidPixels(img, polygonGeometry) } )
                      .filter(ee.Filter.gte('invalid_percentage', 0.97))
                      .map(calculateNDWI);
  
  var metricsList = filteredCollection.map(function(firstImage) {
    
    var th = -0.01
  
    var water = firstImage.select("NDWI").gt(th)
    // compute surface water area
    var SurfaceArea = ee.Image.pixelArea().mask(water)
      .reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: polygonGeometry,
        scale: 30,
        maxPixels: 1e13
      }).get('area')
    

      return firstImage.set({'date': firstImage.date().format('YYYY-MM-dd'), 'area': SurfaceArea});
    })

  return ee.Feature(null, {
    "objectid": feature.get("objectid"),
    "setname": feature.get("setname"),
    'reservoir_name': feature.get("wbname"),
  'areas': (metricsList.aggregate_array('area')),
  'dates':(metricsList.aggregate_array('date'))
})
}



