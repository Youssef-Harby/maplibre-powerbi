import powerbiVisualsApi from "powerbi-visuals-api";
import * as chroma from "chroma-js"
import { featureCollection } from "@turf/helpers"
import { propEach } from "@turf/meta"
import { MapboxSettings } from "./settings";

export enum ClassificationMethod {
    Quantile,
    Equidistant,
    Logarithmic,
    NaturalBreaks,
}

export interface Limits {
    min: number;
    max: number;
    values: number[];
}

export function zoomToData(map, bounds) {
    if (bounds) {
        map.fitBounds(bounds, {
            padding: 20,
            maxZoom: 15,
        });

    }
}

export function shouldUseGradient(colorColumn) {
    return colorColumn && colorColumn.aggregates != null;
}

export function debounce(func, wait, immediate) {
    let timeout;
    return function () {
        let context = this, args = arguments;
        let later = function () {
            timeout = null;
            if (!immediate) func.apply(context, args);
        };
        let callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func.apply(context, args);
    };
};


export function getClassCount(values: number[]) {
    const MAX_BOUND_COUNT = 6;
    // For example if you want 5 classes, you have to enter 6 bounds
    // (1 bound is the minimum value, 1 bound is the maximum value,
    // the rest are class separators)
    const classCount = Math.min(values.length, MAX_BOUND_COUNT) - 1;
    return classCount;
}

export function getBreaks(values: number[], method: ClassificationMethod, classCount: number): number[] {
    let chromaMode: 'e' | 'q' | 'l' | 'k';

    switch (method) {
        case ClassificationMethod.Equidistant:
            chromaMode = 'e'
            break;
        case ClassificationMethod.Logarithmic:
            chromaMode = 'l'
            break;
        case ClassificationMethod.NaturalBreaks:
            chromaMode = 'k'
            break;
        case ClassificationMethod.Quantile:
            chromaMode = 'q'
            break;
        default:
            break;
    }

    return chroma.limits(values, chromaMode, classCount);
}

export function positionInArray(array: any[], element: any) {
    let found = false
    for (let i = 0; i <= array.length; i++) {
        if (array[i] == element) {
            found = true
            break
        }
    }
    if (!found) {
        return -1
    }
}

export function pushIfNotExist(array: any[], element: any) {
    if (positionInArray(array, element) === -1) {
        array.push(element)
    }
}

export function decorateLayer(layer) {
    switch (layer.type) {
        case 'circle': {
            layer.paint = {};
            break;
        }
        case 'cluster': {
            layer.type = 'circle';
            break;
        }
        case 'heatmap': {
            layer.paint = {};
            break;
        }
    }
    return layer;
}

export function filterValues(values: number[], minValue: number, maxValue: number) {
    let filterFn;

    if (minValue != null && maxValue != null) {
        filterFn = (val) => (val >= minValue) && (val <= maxValue);
    }
    else if (maxValue != null) {
        filterFn = (val) => val <= maxValue;
    }
    else if (minValue != null) {
        filterFn = (val) => val >= minValue;
    }
    else {
        return values
    }

    return values.filter(filterFn);
}

export function getLimits(data, myproperty): Limits {

    let min = null;
    let max = null;
    let values = [];

    if (data && data.length > 0 && myproperty != '') {
        if (data[0]['type']) {
            // data are geojson
            propEach(featureCollection(data), function (currentProperties, featureIndex) {
                if (currentProperties[myproperty] || currentProperties[myproperty] === 0) {
                    const value = currentProperties[myproperty];
                    if (!min || value < min) { min = value }
                    if (!max || value > max) { max = value }
                    pushIfNotExist(values, value)
                }
            })
        }
        else {
            // data are non-geojson objects for a choropleth
            data.forEach(f => {
                if (f[myproperty] !== undefined && f[myproperty] !== null) {
                    const value = f[myproperty];
                    if (!min || value < min) { min = value }
                    if (!max || value > max) { max = value }
                    pushIfNotExist(values, value)
                }
            })
        }
    }

    // Min and max must not be equal because of the interpolation.
    // let's make sure with the substraction if it is a number
    if (min && min.toString() !== min && min == max) {
        min = min - 1
    }

    return {
        min,
        max,
        values
    }
}

export function getCategoricalObjectValue<T>(category: powerbiVisualsApi.DataViewCategoryColumn, index: number, objectName: string, propertyName: string, defaultValue: T): T {
    let categoryObjects = category.objects;

    if (categoryObjects) {
        let categoryObject: powerbiVisualsApi.DataViewObject = categoryObjects[index];
        if (categoryObject) {
            let object = categoryObject[objectName];
            if (object) {
                let property: T = object[propertyName];
                if (property !== undefined) {
                    return property;
                }
            }
        }
    }
    return defaultValue;
}


export function dragElement(el) {
    let diffX = 0, diffY = 0, startX = 0, startY = 0;
    el.addEventListener('mousedown', dragMouseDown);

    function dragMouseDown(e) {
        e = e || window.event;
        // get the mouse cursor position at startup:
        startX = e.clientX;
        startY = e.clientY;
        document.addEventListener('mouseup', closeDragElement);
        document.addEventListener('mousemove', elementDrag);
    }

    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        // calculate the new cursor position:
        diffX = e.clientX - startX;
        diffY = e.clientY - startY;
        startX = e.clientX;
        startY = e.clientY;

        el.style.top = (el.offsetTop + diffY) + "px";
        el.style.left = (el.offsetLeft + diffX) + "px";
        el.style.cursor = "grab";
        el.style.pointerEvents = "none"
    }

    function closeDragElement() {
        document.removeEventListener('mouseup', closeDragElement);
        document.removeEventListener('mousemove', elementDrag);
        el.style.cursor = "default";
        el.style.pointerEvents = "all"
    }
}

export function calculateLabelPosition(settings: MapboxSettings, map: mapboxgl.Map): string {
    // If there is no firstSymbolId specified, it adds the data as the last element.
    let firstSymbolId: string = null;
    if (settings.api.labelPosition === 'above') {
        // For default styles place data under waterway-label layer
        firstSymbolId = 'waterway-label';
        if (settings.api.style == 'mapbox://styles/mapbox/satellite-v9?optimize=true' ||
            settings.api.style == 'custom') {
            // For custom style find the lowest symbol layer to place data underneath
            firstSymbolId = '';
            let layers = map.getStyle().layers;
            for (let i = 0; i < layers.length; i++) {
                if (layers[i].type === 'symbol') {
                    firstSymbolId = layers[i].id;
                    break;
                }
            }
        }
    }
    return firstSymbolId;
}