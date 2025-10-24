# helpers-contentful

Helper package for Contentful CMS integration with translation pipelines.

## Overview

This package provides source and target adapters for integrating Contentful CMS with translation pipelines. It enables automated localization of Contentful content including plain text, rich text, and structured content.

## Features

- **ContentfulSource**: Fetches content from Contentful CDA (Content Delivery API)
- **ContentfulTarget**: Pushes translations to Contentful CMA (Content Management API)
- **Rich Text Support**: Full support for Contentful rich text with HTML rendering
- **Content Filtering**:
  - Content type whitelisting
  - Do Not Translate (DNT) tag support
  - Automatic detection of localized fields
- **Smart Updates**: Only updates entries when translations have changed

## Installation

```bash
npm install helpers-contentful
```

Or as a local package in a monorepo:

```json
{
  "dependencies": {
    "helpers-contentful": "file:../../packages/helpers-contentful"
  }
}
```

## Usage

### Basic Example

```javascript
import { ContentfulSource, ContentfulTarget } from 'helpers-contentful';
import { ChannelConfig } from '@l10nmonster/core';

const contentfulConfig = {
    host: 'api.contentful.com',
    space: 'your-space-id',
    accessToken: 'your-access-token',
    environment: 'master'
};

const channel = new ChannelConfig('my-contentful-channel')
    .source(new ContentfulSource({
        ...contentfulConfig,
        prj: 'my-project',
        contentTypeWhiteList: ['pages', 'blogPost', 'article'],
        dntTagList: ['doNotTranslate']
    }))
    .target(new ContentfulTarget({
        ...contentfulConfig,
        prj: 'my-project',
        langMapper: (lang) => lang.slice(0, 2) // 'es-419' → 'es'
    }));
```

### Constructor Options

#### ContentfulSource

| Option | Type | Description |
|--------|------|-------------|
| `prj` | string | Project identifier |
| `host` | string | Contentful API host (e.g., 'api.contentful.com') |
| `space` | string | Contentful space ID |
| `accessToken` | string \| function | CDA access token or async function returning token |
| `environment` | string | Contentful environment (e.g., 'master', 'staging') |
| `contentTypeWhiteList` | string[] | Array of content type IDs to process |
| `dntTagList` | string[] | Array of tag IDs to exclude from translation |

#### ContentfulTarget

| Option | Type | Description |
|--------|------|-------------|
| `prj` | string | Project identifier |
| `host` | string | Contentful API host |
| `space` | string | Contentful space ID |
| `accessToken` | string \| function | CMA access token or async function returning token |
| `environment` | string | Contentful environment |
| `langMapper` | function | Function to map L10n Monster language codes to Contentful locale codes |

## Content Types Supported

### Plain Text Fields
Simple string fields are extracted and translated directly.

### Rich Text Fields
Contentful rich text documents are processed with:
- Block-level elements (paragraphs, headings, lists, tables)
- Inline formatting (bold, italic, links)
- Embedded entries
- HTML rendering for translation

### Array Fields
JSON arrays with structured data (e.g., form inputs) are supported with field-level translation (title, placeholder, etc.).

## Environment Variables

- `DEBUG_CONTENTFUL`: Enable verbose logging
- `DEBUG_WRITE_CONTENTFUL`: Write debug files to local filesystem

## Language Mapping

The `langMapper` function allows you to convert between L10n Monster's language codes and Contentful's locale codes:

```javascript
// Example: Convert BCP-47 codes to 2-letter codes
const langMapper = (lang) => {
    return ['es-419', 'fr-FR', 'ja-JP'].includes(lang)
        ? lang.slice(0, 2)
        : lang;
};
```

## How It Works

1. **Fetch**: Source adapter retrieves entries from Contentful via CDA
2. **Filter**: Applies content type whitelist and DNT tag exclusions
3. **Extract**: Segments translatable content from localized fields
4. **Translate**: Translation pipeline processes content
5. **Commit**: Target adapter updates Contentful entries via CMA
6. **Publish**: Automatically publishes updated entries

## Debug Options

Enable debug logging with environment variables:

```bash
DEBUG_CONTENTFUL=1          # Verbose logging
DEBUG_WRITE_CONTENTFUL=1    # Write debug files locally
```

When `DEBUG_WRITE_CONTENTFUL` is enabled, the following files are created:
- `localizedFieldList.json` - Localized fields by content type
- `entriesContent.json` - Raw entries from Contentful
- `resourceStatOutput.json` - Processed resource metadata
- `entriesTmp.json` - Entry data cache
- `contentful/source/entry-*.json` - Source entry snapshots
- `contentful/target/{lang}/entry-*-updated.json` - Updated entries before commit

## API Reference

### ContentfulSource

#### Methods

##### `async fetchResourceStats()`
Returns an array of resource metadata objects with translation status.

##### `async fetchResource(resourceId)`
Fetches and segments a single resource for translation. Returns JSON string with segments.

##### `async *fetchAllResources({ since })`
Generator that yields `[resourceMeta, resourceData]` tuples for all resources.

**Parameters:**
- `since` (optional): ISO timestamp to fetch only resources modified after this date

### ContentfulTarget

#### Methods

##### `translatedResourceId(lang, resourceId)`
Returns the resource ID for a given language (currently same as source ID).

##### `async fetchTranslatedResource(lang, resourceId)`
Fetches existing translation for a resource (placeholder method).

##### `async commitTranslatedResource(lang, resourceId, translatedRes)`
Commits translated content back to Contentful and publishes.

**Parameters:**
- `lang`: Target language code
- `resourceId`: Resource identifier
- `translatedRes`: JSON string containing translated segments

## Resource ID Format

Resources are identified using the format: `{contentType}-{entryId}`

Example: `pages-3xK8JF9mN2pQzL1vR4wS6H`

## Segment ID Format

Segments use different ID patterns based on field type:
- **Plain text**: Field name (e.g., `title`)
- **Rich text blocks**: `{fieldName}-{index}` (e.g., `content-0`, `content-1`)
- **Array fields**: `{fieldName}-{property}` (e.g., `formInput-title`, `formInput-placeholder`)

