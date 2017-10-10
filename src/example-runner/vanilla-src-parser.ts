import {generate} from 'escodegen';
import * as esprima from 'esprima';
import {Events} from '../../../ag-grid/src/ts/eventKeys';
import {PropertyKeys} from '../../../ag-grid/src/ts/propertyKeys';
import * as $ from 'jquery';

const EVENTS = (<any>Object).values(Events);
const PROPERTIES = PropertyKeys.ALL_PROPERTIES;
const FUNCTION_PROPERTIES = PropertyKeys.FUNCTION_PROPERTIES;

function collect(iterable, accumulator, collectors) {
    return iterable.reduce((col, value) => {
        collectors.forEach(collector => {
            if (collector.matches(value)) {
                collector.apply(col, value);
            }
        });

        return col;
    }, accumulator);
}

function nodeIsVarNamed(node, name) {
    return node.type === 'VariableDeclaration' && (<any>node.declarations[0].id).name === name;
}

function nodeIsFunctionNamed(node, name) {
    return node.type === 'FunctionDeclaration' && (<any>node.id).name === name;
}

function nodeIsUnusedFunction(node, used) {
    return node.type === 'FunctionDeclaration' && used.indexOf((<any>node.id).name) === -1;
}

function nodeIsUnusedVar(node, used) {
    return node.type === 'VariableDeclaration' && used.indexOf((<any>node.declarations[0].id).name) === -1;
}

function nodeIsPropertyNamed(node, name) {
    // we skip { property: variable }
    // and get only inline property assignments
    return node.key.name == name && node.value.type != 'Identifier';
}

function nodeIsDocumentContentLoaded(node) {
    return (
        node.type === 'ExpressionStatement' &&
        node.expression.type == 'CallExpression' &&
        node.expression.arguments[0].type === 'Literal' &&
        node.expression.arguments[0].value === 'DOMContentLoaded'
    );
}

function nodeIsFetchDataCall(node) {
    return node.type === 'ExpressionStatement' && node.expression.callee && node.expression.callee.name === 'fetchData';
}

function nodeIsResizeColumnsToFit(node) {
    return node.expression && node.expression.callee && node.expression.callee.property && node.expression.callee.property.name == 'sizeColumnsToFit';
}

function nodeIsHttpOpen(node) {
    const calleeObject = node.expression && node.expression.callee && node.expression.callee.object;
    return node.type === 'ExpressionStatement' && calleeObject && calleeObject.name === 'httpRequest' && node.expression.callee.property.name === 'open';
}

function nodeIsSimpleHttpRequest(node) {
    const calleeObject = node.expression && node.expression.callee && node.expression.callee.object;
    const innerCallee = calleeObject && calleeObject.callee && calleeObject.callee.object;
    const innerProperty = calleeObject && calleeObject.callee && calleeObject.callee.property;

    return innerCallee && innerProperty && innerCallee.name == 'agGrid' && innerProperty.name == 'simpleHttpRequest';
}

export const recognizedDomEvents = ['click', 'change', 'input'];

const arrayMap = function(array, callback) {
    return Array.prototype.map.call(array, callback);
};

const flatMap = function(array, callback) {
    return Array.prototype.concat.apply([], array.map(callback));
};

const extractEventHandlerBody = call => call.match(/^([\w]+)\((.*)\)/);
const getAttr = attrName => el => el.getAttribute(attrName);

function extractEventHandlers(tree, eventNames: string[]) {
    return flatMap(eventNames, eventName => {
        return arrayMap(tree.find(`[on${eventName}]`), getAttr(`on${eventName}`)).map(extractEventHandlerBody);
    });
}

export default function parser([js, html], gridSettings, {gridOptionsLocalVar}) {
    const localGridOptions = esprima.parseScript(gridOptionsLocalVar).body[0];

    const domTree = $(`<div>${html}</div>`);

    domTree.find('style').remove();

    const domEventHandlers = extractEventHandlers(domTree, recognizedDomEvents);
    const tree = esprima.parseScript(js);
    const collectors = [];
    const gridOptionsCollectors = [];
    const onReadyCollectors = [];

    const indentOne = {format: {indent: {base: 1}}};

    const registered = ['gridOptions', 'fetchData'];

    domEventHandlers.forEach(([_, handler, params]) => {
        if (registered.indexOf(handler) > -1) {
            return;
        }

        registered.push(handler);

        collectors.push({
            matches: node => nodeIsFunctionNamed(node, handler),
            apply: (col, node) => {
                const body = node.body;
                body.body.unshift(localGridOptions);

                const code = generate(node, indentOne);

                col.externalEventHandlers.push({
                    name: handler,
                    params: params,
                    body: code
                });
            }
        });
    });

    collectors.push({
        matches: node => nodeIsUnusedFunction(node, registered),
        apply: (col, node) => {
            col.utils.push(generate(node));
        }
    });

    collectors.push({
        matches: node => nodeIsUnusedVar(node, registered),
        apply: (col, node) => {
            col.utils.push(generate(node));
        }
    });

    // extract the fetchData call
    onReadyCollectors.push({
        matches: nodeIsFetchDataCall,
        apply: (col, node) => {
            const dataUrl = node.expression.arguments[0].raw;
            const callback = node.expression.arguments[1].body;

            col.data = {
                url: dataUrl,
                callback: generate(callback, {format: {indent: {base: 2}}})
            };
        }
    });

    // extract the xmlhttpreq call
    onReadyCollectors.push({
        matches: nodeIsHttpOpen,
        apply: (col, node) => {
            const dataUrl = node.expression.arguments[1].raw;
            // Let's try this for now
            const callback = '      { gridOptions.api.setRowData(data) }';

            col.data = {url: dataUrl, callback: callback};
        }
    });

    // extract the xmlhttpreq call
    onReadyCollectors.push({
        matches: nodeIsSimpleHttpRequest,
        apply: (col, node) => {
            const dataUrl = node.expression.callee.object.arguments[0].properties[0].value.raw;
            // Let's try this for now
            const callback = '      { gridOptions.api.setRowData(data) }';

            col.data = {url: dataUrl, callback: callback};
        }
    });

    // extract the resizeColumnsToFit
    onReadyCollectors.push({
        matches: nodeIsResizeColumnsToFit,
        apply: (col, node) => {
            col.resizeToFit = true;
        }
    });

    // extract onready
    collectors.push({
        matches: nodeIsDocumentContentLoaded,
        apply: (col, node) => {
            collect(node.expression.arguments[1].body.body, col, onReadyCollectors);
        }
    });

    EVENTS.forEach(eventName => {
        var onEventName = 'on' + eventName.replace(/^\w/, w => w.toUpperCase());

        registered.push(onEventName);

        collectors.push({
            matches: node => nodeIsFunctionNamed(node, onEventName),
            apply: (col, node) => {
                node.body.body.unshift(localGridOptions);
                col.eventHandlers.push({name: eventName, handlerName: onEventName, handler: generate(node, indentOne)});
            }
        });
    });

    FUNCTION_PROPERTIES.forEach(functionName => {
        registered.push(functionName);
        collectors.push({
            matches: node => nodeIsFunctionNamed(node, functionName),
            apply: (col, node) => {
                col.properties.push({name: functionName, value: generate(node, indentOne)});
            }
        });
    });

    PROPERTIES.forEach(propertyName => {
        registered.push(propertyName);
        // grab global variables named as grid properties
        collectors.push({
            matches: node => nodeIsVarNamed(node, propertyName),
            apply: (col, node) => col.properties.push({name: propertyName, value: generate(node.declarations[0].init, indentOne)})
        });

        gridOptionsCollectors.push({
            matches: node => nodeIsPropertyNamed(node, propertyName),
            apply: (col, node) => col.properties.push({name: propertyName, value: generate(node.value, indentOne)})
        });
    });

    gridOptionsCollectors.push({
        matches: node => nodeIsPropertyNamed(node, 'onGridReady'),
        apply: (col, node) => {
            col.onGridReady = generate(node.value.body);
        }
    });

    collectors.push({
        matches: node => nodeIsVarNamed(node, 'gridOptions'),
        apply: (col, node) => collect(node.declarations[0].init.properties, col, gridOptionsCollectors)
    });

    const bindings = collect(
        tree.body,
        {
            eventHandlers: [],
            properties: [],
            externalEventHandlers: [],
            utils: []
        },
        collectors
    );

    const gridElement = domTree.find('#myGrid').replaceWith('$$GRID$$');
    const inlineClass = gridElement.attr('class');
    const inlineHeight = gridElement.css('height');
    const inlineWidth = gridElement.css('width');
    if (inlineClass) {
        gridSettings.theme = inlineClass;
    }

    if (parseInt(inlineHeight)) {
        gridSettings.height = inlineHeight;
    }

    if (parseInt(inlineWidth)) {
        gridSettings.width = inlineWidth;
    }

    bindings.template = domTree.html().replace(/<br>/g, '<br />');

    bindings.gridSettings = (<any>Object).assign({width: '100%', height: '100%', theme: 'ag-fresh'}, gridSettings);
    return bindings;
}
