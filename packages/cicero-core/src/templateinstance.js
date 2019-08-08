/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const Logger = require('@accordproject/ergo-compiler').Logger;
const ParseException = require('@accordproject/ergo-compiler').ComposerConcerto.ParseException;
const crypto = require('crypto');
const ErrorUtil = require('./errorutil');
const Util = require('@accordproject/ergo-compiler').Util;
const moment = require('moment-mini');
// Make sure Moment serialization preserves utcOffset. See https://momentjs.com/docs/#/displaying/as-json/
moment.fn.toJSON = Util.momentToJson;
const ErgoEngine = require('@accordproject/ergo-engine/index.browser.js').EvalEngine;

const RelationshipDeclaration = require('@accordproject/ergo-compiler').ComposerConcerto.RelationshipDeclaration;

/**
 * A TemplateInstance is an instance of a Clause or Contract template. It is executable business logic, linked to
 * a natural language (legally enforceable) template.
 * A TemplateInstance must be constructed with a template and then prior to execution the data for the clause must be set.
 * Set the data for the TemplateInstance by either calling the setData method or by
 * calling the parse method and passing in natural language text that conforms to the template grammar.
 * @public
 * @abstract
 * @class
 */
class TemplateInstance {

    /**
     * Create the Clause and link it to a Template.
     * @param {Template} template  - the template for the clause
     */
    constructor(template) {
        if (this.constructor === TemplateInstance) {
            throw new TypeError('Abstract class "TemplateInstance" cannot be instantiated directly.');
        }
        this.template = template;
        this.data = null;
        this.composerData = null;
        this.ergoEngine = new ErgoEngine();
    }

    /**
     * Set the data for the clause
     * @param {object} data  - the data for the clause, must be an instance of the
     * template model for the clause's template. This should be a plain JS object
     * and will be deserialized and validated into the Composer object before assignment.
     */
    setData(data) {
        // verify that data is an instance of the template model
        const templateModel = this.getTemplate().getTemplateModel();

        if (data.$class !== templateModel.getFullyQualifiedName()) {
            throw new Error(`Invalid data, must be a valid instance of the template model ${templateModel.getFullyQualifiedName()} but got: ${JSON.stringify(data)} `);
        }

        // downloadExternalDependencies the data using the template model
        Logger.debug('Setting clause data: ' + JSON.stringify(data));
        const resource = this.getTemplate().getSerializer().fromJSON(data);
        resource.validate();

        // save the data
        this.data = data;

        // save the composer data
        this.composerData = resource;
    }

    /**
     * Get the data for the clause. This is a plain JS object. To retrieve the Composer
     * object call getComposerData().
     * @return {object} - the data for the clause, or null if it has not been set
     */
    getData() {
        return this.data;
    }

    /**
     * Get the data for the clause. This is a Composer object. To retrieve the
     * plain JS object suitable for serialization call toJSON() and retrieve the `data` property.
     * @return {object} - the data for the clause, or null if it has not been set
     */
    getDataAsComposerObject() {
        return this.composerData;
    }

    /**
     * Set the data for the clause by parsing natural language text.
     * @param {string} text  - the data for the clause
     * @param {string} currentTime - the definition of 'now' (optional)
     * @param {string} fileName - the fileName for the text (optional)
     */
    parse(text, currentTime, fileName) {
        // Set the current time and UTC Offset
        const now = Util.setCurrentTime(currentTime);
        const utcOffset = now.utcOffset();

        let parser = this.getTemplate().getParserManager().getParser();
        try {
            parser.feed(text);
        } catch(err) {
            const fileLocation = ErrorUtil.locationOfError(err);
            throw new ParseException(err.message, fileLocation, fileName, err.message, 'cicero-core');
        }
        if (parser.results.length !== 1) {
            const head = JSON.stringify(parser.results[0]);

            parser.results.forEach(function (element) {
                if (head !== JSON.stringify(element)) {
                    throw new Error('Ambiguous text. Got ' + parser.results.length + ' ASTs for text: ' + text);
                }
            }, this);
        }
        let ast = parser.results[0];
        Logger.debug('Result of parsing: ' + JSON.stringify(ast));

        if(!ast) {
            throw new Error('Parsing clause text returned a null AST. This may mean the text is valid, but not complete.');
        }

        ast = TemplateInstance.convertDateTimes(ast, utcOffset);
        this.setData(ast);
    }

    /**
     * Recursive function that converts all instances of ParsedDateTime
     * to a Moment.
     * @param {*} obj the input object
     * @param {number} utcOffset - the default utcOffset
     * @returns {*} the converted object
     */
    static convertDateTimes(obj, utcOffset) {
        if(obj.$class === 'ParsedDateTime') {

            let instance = null;

            if(obj.timezone) {
                instance = moment(obj).utcOffset(obj.timezone, true);
            }
            else {
                instance = moment(obj)
                    .utcOffset(utcOffset, true);
            }

            if(!instance) {
                throw new Error(`Failed to handle datetime ${JSON.stringify(obj, null, 4)}`);
            }
            const result = instance.format('YYYY-MM-DDTHH:mm:ss.SSSZ');
            if(result === 'Invalid date') {
                throw new Error(`Failed to handle datetime ${JSON.stringify(obj, null, 4)}`);
            }
            return result;
        }
        else if( typeof obj === 'object' && obj !== null) {
            Object.entries(obj).forEach(
                ([key, value]) => {obj[key] = TemplateInstance.convertDateTimes(value, utcOffset);}
            );
        }

        return obj;
    }

    /**
     * Generates the natural language text for a contract or clause clause; combining the text from the template
     * and the instance data.
     * @param {*} [options] text generation options. options.wrapVariables encloses variables
     * and editable sections in '<variable ...' and '/>'
     * @returns {string} the natural language text for the contract or clause; created by combining the structure of
     * the template with the JSON data for the clause.
     */
    async generateText(options) {
        if(!this.composerData) {
            throw new Error('Data has not been set. Call setData or parse before calling this method.');
        }

        const params = {
            options: {
                '$class': 'org.accordproject.markdown.MarkdownOptions',
                'wrapVariables': options && options.wrapVariables ? options.wrapVariables : false,
            }
        };
        const logicManager = this.getLogicManager();
        const clauseId = this.getIdentifier();
        const contract = this.getData();

        return logicManager.compileLogic(false).then(async () => {
            const result = await this.ergoEngine.generateText(logicManager,clauseId,contract,params,null);
            return result.response;
        });
    }

    /**
     * Converts a composer object to a string
     * @param {ClassDeclaration} clazz - the composer classdeclaration
     * @param {object} obj - the instance to convert
     * @returns {string} the parseable string representation of the object
     * @private
     */
    convertClassToString(clazz, obj) {
        const properties = clazz.getProperties();
        let result = '';
        for(let n=0; n < properties.length; n++) {
            const child = properties[n];
            result += this.convertPropertyToString(child, obj[child.getName()]);

            if(n < properties.length-1) {
                result += ' ';
            }
        }

        return result;
    }

    /**
     * Returns moment Date object parsed using a format string
     * @param {Date} date - date/time string to parse
     * @param {string} format - the optional format string. If not specified
     * this defaults to 'MM/DD/YYYY'
     * @returns {string} ISO-8601 formatted date as a string
     * @private
     */
    static formatDateTime(date, format) {
        if(!format) {
            format = 'MM/DD/YYYY';
        }
        const instance = moment.parseZone(date);
        return instance.format(format);
    }


    /**
     * Converts a composer object to a string
     * @param {Property} property - the composer property
     * @param {object} obj - the instance to convert
     * @param {string} format - the optional format string to use
     * @returns {string} the parseable string representation of the object
     * @private
     */
    convertPropertyToString(property, obj, format) {

        if(property.isOptional() === false && !obj) {
            throw new Error(`Required property ${property.getFullyQualifiedName()} is null.`);
        }

        if(property instanceof RelationshipDeclaration) {
            return `"${obj.getIdentifier()}"`;
        }

        if(property.isTypeEnum()) {
            return obj;
        }

        if(format) {
            // strip quotes
            format = format.substr(1, format.length-2);
        }

        // uncomment this code when the templates support arrays
        // if(property.isArray()) {
        //     let result = '';
        //     for(let n=0; n < obj.length; n++) {
        //         result += this.convertPropertyToString(this.getTemplate().getTemplateModel().
        //             getModelFile().getModelManager().getType(property.getFullyQualifiedTypeName()), obj[n] );

        //         if(n < obj.length-1) {
        //             result += ' ';
        //         }
        //     }
        //     return result;
        // }

        switch(property.getFullyQualifiedTypeName()) {
        case 'String':
            return `"${obj}"`;
        case 'Integer':
        case 'Long':
        case 'Double':
            return obj.toString();
        case 'DateTime':
            return TemplateInstance.formatDateTime(obj, format);
        case 'Boolean':
            if(obj) {
                return 'true';
            }
            else {
                return 'false';
            }
        default:
            return this.convertClassToString(this.getTemplate().getTemplateModel().
                getModelFile().getModelManager().getType(property.getFullyQualifiedTypeName()), obj);
        }
    }


    /**
     * Returns the identifier for this clause. The identifier is the identifier of
     * the template plus '-' plus a hash of the data for the clause (if set).
     * @return {String} the identifier of this clause
     */
    getIdentifier() {
        let hash = '';

        if (this.data) {
            const textToHash = JSON.stringify(this.getData());
            const hasher = crypto.createHash('sha256');
            hasher.update(textToHash);
            hash = '-' + hasher.digest('hex');
        }
        return this.getTemplate().getIdentifier() + hash;
    }

    /**
     * Returns the template for this clause
     * @return {Template} the template for this clause
     */
    getTemplate() {
        return this.template;
    }

    /**
     * Returns the template logic for this clause
     * @return {LogicManager} the template for this clause
     */
    getLogicManager() {
        return this.template.getLogicManager();
    }

    /**
     * Returns a JSON representation of the clause
     * @return {object} the JS object for serialization
     */
    toJSON() {
        return {
            template: this.getTemplate().getIdentifier(),
            data: this.getData()
        };
    }
}

module.exports = TemplateInstance;