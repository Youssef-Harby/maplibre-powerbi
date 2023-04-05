import { Datasource } from "./datasource"
import { Limits, getLimits, zoomToData } from "../mapboxUtils"
import { MapboxSettings } from "../settings"
import { BBoxCache } from "./bboxCache"
import { RoleMap } from "../roleMap"

export class Choropleth extends Datasource {
    private choroplethData: any[];
    private fillColorLimits: Limits[];
    private fillSizeLimits: Limits;
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

    private getLimitsAtIndex(limits: Limits[], index: number): Limits {
        if (index >= 0 && index < limits.length) {
            return limits[index]
        }

        return { min: null, max: null, values: [] }
    }

    getLimits(index: number) {
        return {
            color: this.getLimitsAtIndex(this.fillColorLimits, index),
            size: this.fillSizeLimits
        }
    }

    getData(map, settings): any[] {
        return this.choroplethData;
    }

    update(map, features, roleMap: RoleMap, settings: MapboxSettings) {
        super.update(map, features, roleMap, settings)
        let featureNames = {}

        const f = features.map(f => f.properties);
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
                    dataByLocation[location][column.displayName] = rawValues[location].length ? rawValues[location][0] : null;
                    return;
                }

                // Aggreagate the values
                const values = rawValues[location].filter(value => value != null);
                dataByLocation[location][column.displayName] = values?.length ? values[0] : null;
            })
        });

        this.choroplethData = Object.keys(dataByLocation).map( location => dataByLocation[location]);
        const colors = roleMap.getAll('color')
        this.fillColorLimits = (colors || []).map(color => {
            return getLimits(this.choroplethData, color.displayName)
        })
        this.fillSizeLimits = getLimits(this.choroplethData, roleMap.size())
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
                                zoomToData(map, this.bounds)
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
                    zoomToData(map, this.bounds)
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
