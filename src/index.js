import fs from 'fs';
import * as contentful from 'contentful';
import contentfulCM from 'contentful-management';
import { htmlStringToDocument } from "contentful-rich-text-html-parser";
import { BLOCKS, MARKS, helpers  } from '@contentful/rich-text-types';
import { documentToHtmlString } from '@contentful/rich-text-html-renderer';
import { documentToPlainTextString } from '@contentful/rich-text-plain-text-renderer';
import _ from 'lodash';
const DEBUG = process.env.DEBUG_CONTENTFUL;
const DEBUG_WRITE = process.env.DEBUG_WRITE_CONTENTFUL;

/*
 inlines - https://github.com/contentful/rich-text/blob/master/packages/rich-text-types/src/inlines.ts
 blocks - https://github.com/contentful/rich-text/blob/master/packages/rich-text-types/src/blocks.ts
 nodeTypes - https://github.com/contentful/rich-text/blob/master/packages/rich-text-types/src/nodeTypes.ts
 */

async function getLocalizedFields(client) {
    console.log('Fetching contentTypes from Contentful...');
    const response = await client.getContentTypes({ limit: 1000 });
    //whitelist for localized fields
    const localizedFieldList = response.items.reduce( (acc, item) => {
        acc[item.sys.id] = item.fields.filter(field => field.localized).map(field => field.id);
        return acc;
    }, {});
    DEBUG_WRITE && fs.writeFileSync('localizedFieldList.json', JSON.stringify(localizedFieldList, null, '\t'));
    return localizedFieldList;
}

const RENDER_OPTIONS = {
    renderMark: {
      [MARKS.BOLD]: text => `<b>${text}</b>`
    },
    renderNode: {
      [BLOCKS.PARAGRAPH]: (node, next) => `<p>${next(node.content)}</p>`
    }
}

export class ContentfulSource {
    constructor({prj, host, space, accessToken, environment, contentTypeWhiteList, dntTagList}) {
        this.prj = prj;
        this.host = host;
        this.space = space;
        this.accessToken = accessToken;
        this.environment = environment;
        this.contentTypeWhiteList = contentTypeWhiteList;
        this.dntTagList = dntTagList;
        this.localizedFieldList = {};
        this.entries = {}
    }

    #addEntry(resources, e ){
        // filter out doNotTranslate
        if (e.metadata.tags && e.metadata.tags.find(s=>s.sys.linkType==='Tag' && this.dntTagList.includes(s.sys.id))) {
            DEBUG && e.metadata.tags && e.metadata.tags.find(s=>s.sys.linkType==='Tag' && this.dntTagList.includes(s.sys.id)) &&
                console.log(`DNT: ${e.sys.id} : ${e.sys.contentType.sys.id}`);
            return;
        }
        // if entry has been previously added, skip
        if (resources.some((r) => r.id === `${e.sys.contentType.sys.id}-${e.sys.id}`)) {
            return;
        }
        const resMeta = {
            sourceLang: 'en-US',
            id: `${e.sys.contentType.sys.id}-${e.sys.id}`,
            modified: e.sys.updatedAt,
            prj: this.prj,
            resourceFormat: 'MNFv1',
        };
        resources.push(resMeta);
        this.entries[e.sys.id] = e;
    }

    //input is an array of fields
    #checkEntry(resources, fields, contentTypeId) {
        let hasLocalizableFields = false;
        for (const [name, field] of Object.entries(fields)){
            const entry = field['en-US'];
            if (typeof entry === 'string') {
                this.localizedFieldList[contentTypeId].includes(name) && (hasLocalizableFields = true);
            } else if (typeof entry === 'object' && entry.fields) {
                this.#checkEntry(resources, entry.fields, entry.sys.contentType.sys.id) &&
                    this.#addEntry(resources, entry);
            } else if (Array.isArray(entry)) {
                entry.forEach(e => {
                    typeof e === 'object' && e.fields &&
                        this.#checkEntry(resources, e.fields, e.sys.contentType.sys.id) &&
                        this.#addEntry(resources, e);
                });
            } else if (typeof entry === 'object' && entry.content) {
                entry.content.forEach(e=> {
                    if (e.nodeType === BLOCKS.EMBEDDED_ENTRY) {
                        this.#checkEntry(resources, e.data.target.fields, e.data.target.sys.contentType.sys.id) &&
                            this.#addEntry(resources, e.data.target);
                    } else {
                        hasLocalizableFields = true;
                    }
                });
            } else {
                //TODO: if english doesn't exist, but other languages do, need to clear the other languages
                if (!entry || typeof entry === 'boolean' || !(entry.fields || entry.content) ||
                    !this.localizedFieldList[contentTypeId].includes(name) ) continue;
                console.log(`case other: ${typeof entry}: ${contentTypeId} : ${name}`);
            }
        }
        return hasLocalizableFields;
    }

    #addSegment(segments, sid, str, nid, mf) {
        const seg = {
            sid,
            str,
            nid,
            mf,
            nstr: [ str ],
        }
        segments.push(seg);
    }

    //input is a node with node.content
    #resolveContent(rootNode, segments, sid, nid, idx = 0) {
        for (const [nodeIdx, next] of Object.entries(rootNode.content)) {
            const strTmp = documentToHtmlString(next, RENDER_OPTIONS);
            const strTmpPlain = documentToPlainTextString(next);
            if (Object.values(BLOCKS).includes(next.nodeType) &&
                ![ BLOCKS.OL_LIST, BLOCKS.UL_LIST, BLOCKS.TABLE, BLOCKS.TABLE_ROW, BLOCKS.TABLE_CELL, BLOCKS.TABLE_HEADER_CELL ].includes(next.nodeType)) {
                strTmp && strTmpPlain && this.#addSegment(segments, `${sid}-${idx++}`, strTmp, nid, 'html');
            } else {
                // inline items should be in their own segment
                DEBUG && console.log(`   content: inline: ${sid}-${idx} : ${nid} : ${next.nodeType}`);
                idx = this.#resolveContent(next, segments, sid, nid, idx);
            }
        }
        return idx;
    }

    async fetchResourceStats() {
        try {
            const client = contentful.createClient({
                host: this.host,
                space: this.space,
                accessToken: typeof this.accessToken === 'function' ? await this.accessToken() : this.accessToken,
                environment: this.environment,
            });
            this.localizedFieldList = await getLocalizedFields(client);
            console.log('Fetching content from Contentful...');
            const response = await client.getEntries({ limit: 1000 });
            const content = JSON.parse(response.stringifySafe());
            DEBUG_WRITE && fs.writeFileSync('entriesContent.json', JSON.stringify(content, null, '\t'));

            // filter based on whiteList
            const resources = content.items.reduce((acc, entry) => {
                const entryContentTypeId = entry.sys.contentType.sys.id;
                    this.contentTypeWhiteList.includes(entryContentTypeId) &&
                    this.#checkEntry(acc, entry.fields, entryContentTypeId) &&
                    this.#addEntry(acc, entry);
                return acc;
            }, []).sort((a, b) => a.id > b.id ? 1 : -1);
            DEBUG_WRITE && fs.writeFileSync('resourceStatOutput.json', JSON.stringify(resources, null, '\t'));
            DEBUG_WRITE && fs.writeFileSync('entriesTmp.json', JSON.stringify(this.entries, null, '\t'));
            return resources;
        } catch (e) {
            console.log(e);
        }
        return [];
    }

    async fetchResource(resourceId) {
        const entry = this.entries[resourceId.split('-')[1]];
        const contentTypeId = entry.sys.contentType.sys.id;
        let segments = [];
        for (const [name, field] of Object.entries(entry.fields)){
            const node = field['en-US'];
            if (!this.localizedFieldList[contentTypeId].includes(name)) { continue; }
            if (node && typeof node === 'string'){
                this.#addSegment(segments, name, node, entry.sys.id, 'text');
            } else if (node && Array.isArray(node)) {
                // for example formInput/json object - need to add title and placeholder
                for (const [idx, e] of Object.entries(node)) {
                    e.title && this.#addSegment(segments, `${e.fieldName}-title`, e.title, entry.sys.id, 'text');
                    e.placeholder && this.#addSegment(segments, `${e.fieldName}-placeholder`, e.placeholder, entry.sys.id, 'text');
                }
            } else if (typeof node === 'object' && node.content) {
                this.#resolveContent(node, segments, name, entry.sys.id );
            }
        }

        // Skip resources with no translatable segments
        if (segments.length === 0) {
            console.log(`Skipping resource ${resourceId} - no translatable content`);
            return null;
        }

        return JSON.stringify({ segments });
    }

    /**
    * @param {Object} [options] - The parameters for the constructor.
    * @param {Array|string} [options.prj] - Only fetch the specified projects.
    * @param {string} [options.since] - Only fetch resources last modified since.
     */
    async *fetchAllResources({ since } = {}) {
        try {
            const client = contentful.createClient({
                host: this.host,
                space: this.space,
                accessToken: typeof this.accessToken === 'function' ? await this.accessToken() : this.accessToken,
                environment: this.environment,
            });
            this.localizedFieldList = await getLocalizedFields(client);
            console.log('Fetching content from Contentful...');
            const response = await client.getEntries({ limit: 1000 });
            const content = JSON.parse(response.stringifySafe());
            DEBUG_WRITE && fs.writeFileSync('entriesContent.json', JSON.stringify(content, null, '\t'));

            // filter based on whiteList
            const resources = content.items.reduce((acc, entry) => {
                const entryContentTypeId = entry.sys.contentType.sys.id;
                this.contentTypeWhiteList.includes(entryContentTypeId) &&
                    this.#checkEntry(acc, entry.fields, entryContentTypeId) &&
                    this.#addEntry(acc, entry);
                return acc;
            }, []).sort((a, b) => a.id > b.id ? 1 : -1);
            DEBUG_WRITE && fs.writeFileSync('resourceStatOutput.json', JSON.stringify(resources, null, '\t'));
            DEBUG_WRITE && fs.writeFileSync('entriesTmp.json', JSON.stringify(this.entries, null, '\t'));
            for (const r of resources) {
                const resourceData = await this.fetchResource(r.id);
                if (resourceData !== null) {
                    yield[ r, resourceData];
                }
            }
        } catch (e) {
            console.log(e);
        }
    }

}

export class ContentfulTarget {
    constructor({prj, host, space, accessToken, environment, langMapper}) {
        this.prj = prj;
        this.host = host;
        this.space = space;
        this.environment = environment;
        this.accessToken = accessToken;
        this.langMapper = langMapper;
        this.sourceDir = 'contentful/source';
        this.targetDir = 'contentful/target';
    }

    translatedResourceId(lang, resourceId) {
        return resourceId;
    }

    async fetchTranslatedResource(lang, resourceId) {
        console.log(`fetchTranslatedResource: ${lang} : ${resourceId}`);
    }

    #translateInline(entry, nstr, idx){
        if (entry.value) {
            while (typeof nstr[idx] !== 'string' && idx < nstr.length) {
                idx++;
            }
            entry.value = `${nstr[idx++]}`;
        }
        return idx;
    }

    #getTranslation(tus, sid){
        const tu = tus.find(s=>s.sid===sid);
        if (!tu) {
            console.log(`getTranslation: block: ${sid} : No translation`);
        }
        return tu;
    }

    #converNstrToHtml(nstr){
        return nstr.map(s=> typeof s === 'string'? s : s.v).join('');
    }

    // return rich text node from nstr
    #translateParagraph(nstr){
        // convert tu to html
        const str = this.#converNstrToHtml(nstr);
        // convert html to rich text node
        return htmlStringToDocument(str);
    }

    #translateContent(tus, rootNode, sid, idx=0){
        for (const [index, node] of Object.entries(rootNode.content)) {
            // inner block -> paragraph, heading
            if (Object.values(BLOCKS).includes(node.nodeType) &&
                ![ BLOCKS.OL_LIST, BLOCKS.UL_LIST, BLOCKS.TABLE, BLOCKS.TABLE_ROW, BLOCKS.TABLE_CELL, BLOCKS.TABLE_HEADER_CELL ].includes(node.nodeType)) {
                // check if translatable content exists
                const strTmp = documentToHtmlString(node, RENDER_OPTIONS);
                const strTmpPlain = documentToPlainTextString(node);
                if (strTmp && strTmpPlain) {
                    const tu = this.#getTranslation(tus, `${sid}-${idx}`);
                    if (tu && tu.nstr) {
                        const translatedNode = this.#translateParagraph(tu.nstr);
                        translatedNode && (node.content = translatedNode.content);
                    }
                    idx++;
                }
            } else if (node.content) {
                DEBUG && console.log(`translateContent: block: ${sid}-${idx} : ${index} : ${node.nodeType}`);
                idx = this.#translateContent(tus, node, sid, idx);
            } else {
                DEBUG && console.log(`translateContent: other: ${sid}-${idx} : ${index} : ${node.nodeType}`);
            }
        }
        return idx;
    }

    async commitTranslatedResource(lang, resourceId, translatedRes) {
        DEBUG && console.log(`commitTranslatedResource: ${resourceId}`);
        const contentfulLang = this.langMapper(lang);
        const [ contentTypeId, entryId ] = resourceId.split('-');
            try {
            DEBUG_WRITE && !fs.existsSync(this.sourceDir) && fs.mkdirSync(this.sourceDir, {recursive: true});
            DEBUG_WRITE && !fs.existsSync(`${this.targetDir}/${contentfulLang}`) && fs.mkdirSync(`${this.targetDir}/${contentfulLang}`, {recursive: true});
            const client = contentfulCM.createClient({
                    host: this.host,
                    space: this.space,
                    accessToken: typeof this.accessToken === 'function' ? await this.accessToken() : this.accessToken,
                    environment: this.environment,
                });
            const space = await client.getSpace(this.space);
            const environment = await space.getEnvironment(this.environment);
            const entry = await environment.getEntry(entryId);
            const sourceFn = `${this.sourceDir}/entry-${resourceId}.json`;
            DEBUG_WRITE && fs.writeFileSync(sourceFn, JSON.stringify(entry, null, '\t'));
            const tus = JSON.parse(translatedRes).segments;
            if (!tus || tus.length === 0) {
                console.log(`No translation for ${resourceId}`);
                return;
            }
            for (const [name, field] of Object.entries(entry.fields)) {
                const fieldValue = field['en-US'];
                if (typeof fieldValue === 'string') {
                    const tu = tus.find(s=>s.sid===name);
                    tu && (field[contentfulLang] = `${tu.str}`);
                } else if (Array.isArray(fieldValue)) {
                    field[contentfulLang] = _.cloneDeep(fieldValue);
                    for(let e of Object.values(field[contentfulLang])) {
                        if (e.title) {
                            const tu = tus.find(s=>s.sid===`${e.fieldName}-title`);
                            tu && (e.title = `${tu.str}`);
                        }
                        if (e.placeholder) {
                            const tu1 = tus.find(s=>s.sid===`${e.fieldName}-placeholder`);
                            tu1 && (e.placeholder = `${tu1.str}`);
                        }
                    }
                } else if (typeof fieldValue === 'object' && fieldValue.content) {
                    field[contentfulLang] = _.cloneDeep(fieldValue);
                    this.#translateContent(tus, field[contentfulLang], name);
                }
            }
            //Only update if any changes
            //TODO: current check fails if the order of fields is different, use a different way to compare
            const current = JSON.parse(fs.readFileSync(sourceFn, 'utf-8'));
            if (JSON.stringify(entry.fields) !== JSON.stringify(current.fields) && !_.isEqual(entry.fields, current.fields)) {
                console.log(`commitTranslatedResource: Updating: ${resourceId}`);
                DEBUG_WRITE && fs.writeFileSync(`${this.targetDir}/${contentfulLang}/entry-${resourceId}-updated.json`, JSON.stringify(entry, null, '\t'));
                const out = await entry.update();
                await out.publish();
            } else {
                DEBUG && console.log(`   No change: ${resourceId}`);
            }
        } catch (e) {
            console.log(e);
        }
    }
}
