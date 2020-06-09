import { Datasource } from "./datasource"
import { Limits, getLimits, zoomToData } from "../mapboxUtils"
import { MapboxSettings } from "../settings"
import { BBoxCache } from "./bboxCache"
import { RoleMap } from "../roleMap"

export class Choropleth extends Datasource {
    private choroplethData: any[];
    protected colorLimits: Limits[];
    protected sizeLimits: Limits[];
    private bboxCache: BBoxCache;

    private static readonly BBOX_TIMEOUT = 1500
    private static readonly BBOX_TIMER = 'choropleth-bbox-timer'

    constructor() {
        super('choropleth-source');
        this.bboxCache = new BBoxCache()
    }

    addSources(map, settings: MapboxSettings) {
        map.addSource(this.ID, {
            type: 'vector',
            url: settings.choropleth.getCurrentVectorTileUrl(),
        });
        return map.getSource(this.ID);
    }

    removeSources(map) {
        map.removeSource(this.ID);
    }

    ensure(map, layerId, settings): void {
        super.ensure(map, layerId, settings)
        const source: any = map.getSource(this.ID);
        if (!source) {
            this.addToMap(map, settings);
        }
    }

    private getLimitsAtIndex(limits: Limits[], index: number) : Limits {
        if (index >= 0 && index < limits.length) {
            return limits[index]
        }

        return { min: null, max: null, values: [] }
    }

    getColorLimits(index: number) : Limits {
        return this.getLimitsAtIndex(this.colorLimits, index)
    }

    getSizeLimits(index: number) : Limits {
        return this.getLimitsAtIndex(this.sizeLimits, index)
    }

    getData(map, settings): any[] {
        return this.choroplethData;
    }

    update(visual, features, roleMap: RoleMap, settings: MapboxSettings) {
        super.update(visual, features, roleMap, settings)
        const map = visual.getMap()
        let featureNames = {}

        let featuresByLocation = [];
        const f = features.map(f => f.properties);
        const aggregation = settings.choropleth.aggregation;
        let dataByLocation = {}
        const locationCol = roleMap.location();
        roleMap.columns.map( (column: any) => {
            // group values by location for given column
            const rawValues = f.reduce( (acc, curr) => {
                const location = curr[locationCol];
                if (acc[location] === undefined) {
                    acc[location] = []
                }
                acc[location].push(curr[column.displayName])
                return acc;
            }, {})
            
            // based on func aggregate those values for each of these locations
            Object.keys(rawValues).map( location => {
                if (dataByLocation[location] === undefined) {
                    dataByLocation[location] = {}
                }

                // For the categories don't do aggregation, take the first value. Also for non-numeric fields
                if (column.roles.location || 
                    column.roles.latitude || 
                    column.roles.longitude ||
                    !column.type.numeric
                ) {
                    dataByLocation[location][column.displayName] = rawValues[location].length ? rawValues[location][0] : 0
                    return;
                }

                // Aggreagate the values
                const values = rawValues[location]
                switch (aggregation) {
                    case "Count": {
                        dataByLocation[location][column.displayName] = values.length;
                        break;
                    }
                    case "Sum": {
                        dataByLocation[location][column.displayName] = values.reduce( (a,b) => a + b, 0)
                        break;
                    }
                    case "Average": {
                        dataByLocation[location][column.displayName] = values.length ? values.reduce( (a,b) => a + b, 0) / values.length : 0
                        break;
                    }
                    case "Minimum": {
                        dataByLocation[location][column.displayName] = values.reduce( (a, b) => a && (a < b || !b) ? a : b, null);
                        break;
                    }
                    case "Maximum": {
                        dataByLocation[location][column.displayName] = values.reduce( (a, b) => a && (a > b || !b) ? a : b, null);
                        break;
                    }
                    default: {
                        dataByLocation[location][column.displayName] = rawValues[location].length ? rawValues[location][0] : 0
                        break;
                    }
                }
            })
        });

        this.choroplethData = Object.keys(dataByLocation).map( location => dataByLocation[location]);

        let colors = roleMap.getAll('color')
        this.colorLimits = colors.map( color => {
            return getLimits(this.choroplethData, color.displayName)
        })

        let sizes = roleMap.getAll('size'); 
        this.sizeLimits = sizes.map( size => {
            return getLimits(this.choroplethData, size.displayName)
        })

        //const featureNames = this.choroplethData.map(f => f[roleMap.location.displayName])
        const apiSettings = settings.api

        // NOTE: this is a workaround because 'sourcedata' event of mapbox is received multiple times
        // with isSourceLoaded being true. And then sometimes querySourceFeatures() returns an empty set.
        // This is why we are waiting until we get the bounds of the desired features. It is performed in
        // two rounds. In the first round we are starting from the zoom level from the configuration, and
        // if we don't get the desired bounds, the 2nd round is started from the source bounds.
        let in1stRound = true
        if (apiSettings.autozoom) {
            let boundsPoll = null
            const start = Date.now()
            let sourceLoaded = (e) => {

                if (e.sourceId == this.ID || e.type == 'zoomend') {
                    this.bboxCache.update(map, this.ID, settings.choropleth)

                    let currentBounds = null
                    if (this.bounds) {
                        currentBounds = this.bounds.slice()
                    }
                    this.bounds = this.bboxCache.getBBox(Object.keys(featureNames))
                    if (this.bounds == currentBounds) {
                        // Wait a bit more until we get the bounding box for the desired features
                        if (Date.now() - start > Choropleth.BBOX_TIMEOUT) {
                            map.off('sourcedata', sourceLoaded)
                            clearInterval(boundsPoll)

                            if (in1stRound) {
                                // Fall back to source bounds. But when zooming to source bounds ends, give another attempt
                                // to get the bounds of the desired features.
                                in1stRound = false
                                const source = map.getSource(this.ID)
                                this.bounds = source.bounds
                                console.log('Waiting for getting bounds of desired features has timed out. Falling back to source bounds:', this.bounds)
                                visual.updateZoom(settings)
                                map.on('zoomend', sourceLoaded)
                                return
                            }

                            // Bounds not found for the desired features. Stay on source bounds.
                            map.off('zoomend', sourceLoaded)
                        }
                        return
                    }

                    // Found bounds. Success.
                    map.off('sourcedata', sourceLoaded)
                    map.off('zoomend', sourceLoaded)
                    clearInterval(boundsPoll)
                    visual.updateZoom(settings)
                }
            }

            this.bboxCache.update(map, this.ID, settings.choropleth)
            this.bounds = this.bboxCache.getBBox(Object.keys(featureNames))
            if (this.bounds == null) {
                // Source must be still loading, wait for it to finish
                map.on('sourcedata', sourceLoaded)
                boundsPoll = setInterval(() => sourceLoaded({sourceId: this.ID, type: Choropleth.BBOX_TIMER}), 500)
            }
        }
    }
}
