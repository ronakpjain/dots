---
name: drawio-xml
description: Create and edit draw.io diagrams as native, uncompressed XML files, including embedded .drawio.png files. Use when working with .drawio, .drawio.xml, or .drawio.png files, especially when the diagram must remain directly editable in the macOS draw.io desktop app.
compatibility: macOS with /Applications/draw.io.app installed; diagram XML is plain mxGraph XML rather than compressed or encoded data (the `.drawio.png` wrapper may URL-encode its embedded XML).
allowed-tools: read edit write bash
---

# draw.io XML

Create and modify draw.io files directly as plain XML. The file itself is the source of truth; do not substitute Mermaid, SVG, JSON, screenshots, or UI automation for the diagram.

## Non-negotiable format rules

- Use a `.drawio` or `.drawio.xml` file containing an `<mxfile>` document, or a `.drawio.png` file with that XML embedded in PNG metadata.
- Keep each `<diagram>` child uncompressed. Its child must be an `<mxGraphModel>`, not a base64/deflate string. The verifier extracts embedded XML from `.drawio.png` files before applying the same checks.
- Keep the standard root cells in every page:
    - `<mxCell id="0"/>`
    - `<mxCell id="1" parent="0"/>`
- Use unique, stable IDs for pages, vertices, edges, and other cells. Preserve existing IDs when editing.
- Store styles in draw.io’s semicolon-separated `key=value;` syntax, not CSS or JSON.
- Escape XML text and attribute values. At minimum, encode `&` as `&amp;`, `"` as `&quot;`, `<` as `&lt;`, and `>` as `&gt;` where required. If using HTML labels, write tags such as `<br>` escaped inside the `value` attribute.
- Do not replace an existing file with a compressed representation, a different diagram format, or a newly generated document when a targeted edit is sufficient.

## Standard document shape

Use this as the minimal starting point for a new page and adapt the layout to the request:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net" type="device">
  <diagram id="page-1" name="Page-1">
    <mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="node-1" value="Start" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="120" y="120" width="120" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="node-2" value="End" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="360" y="120" width="120" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="edge-1" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;" edge="1" parent="1" source="node-1" target="node-2">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

For a new file, metadata such as `modified`, `agent`, and `version` is optional. When editing an existing file, preserve its metadata and page structure unless the user explicitly asks to change them.

## Cell model

### Vertices (shapes and text)

A shape is an `mxCell` with `vertex="1"`, a `parent`, and absolute geometry:

```xml
<mxCell id="service-api" value="API" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
  <mxGeometry x="240" y="160" width="140" height="60" as="geometry"/>
</mxCell>
```

Use readable semantic IDs for new cells when possible. Keep a consistent coordinate system: place related shapes near one another, align them, and leave enough space for labels and connectors. For a child inside a group or container, use that container’s ID as `parent` and follow the existing document’s geometry conventions.

### Edges (connectors)

An edge has `edge="1"`, a `parent`, and `source` and `target` IDs that attach its ends to shapes:

```xml
<mxCell id="api-to-db" value="reads" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;" edge="1" parent="1" source="service-api" target="database">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
```

**Connection invariant:** every normal connector must have both `source` and `target`, and both IDs must resolve to actual vertex cells (`mxCell` elements with `vertex="1"`) representing boxes, shapes, or other intended endpoints. This `source`/`target` relationship—not an endpoint `x`/`y` coordinate—is what keeps an arrow attached when a shape moves. Use a common valid layer/container as the edge `parent`; do not point an endpoint at the layer root (`id="0"` or `id="1"`) unless a floating connection is explicitly requested.

Create or update vertices before adding edges. For every edge, audit that its `source` and `target` exist, are not duplicated, and refer to the intended shapes. Keep `mxGeometry relative="1" as="geometry"` on connected edges. Do not manually place arrow endpoints with absolute geometry as a substitute for `source` and `target`; waypoints control routing between attached shapes, not attachment itself. An unattached or one-sided edge is allowed only when the user explicitly asks for a floating connector. Add waypoints only when needed:

```xml
<mxGeometry relative="1" as="geometry">
  <Array as="points">
    <mxPoint x="420" y="260"/>
    <mxPoint x="620" y="260"/>
  </Array>
</mxGeometry>
```

### Styles

Common shape styles include:

- `rounded=1`, `shape=ellipse`, `shape=mxgraph.basic.hexagon`
- `fillColor=#dae8fc`, `strokeColor=#6c8ebf`, `fontColor=#1a1a1a`
- `fontStyle=1`, `fontSize=14`, `align=center`, `verticalAlign=middle`
- `whiteSpace=wrap`, `html=1`, `spacing=8`

Common edge styles include:

- `edgeStyle=orthogonalEdgeStyle` or `edgeStyle=elbowEdgeStyle`
- `rounded=0`, `orthogonalLoop=1`, `jettySize=auto`
- `dashed=1`, `startArrow=none`, `endArrow=block`, `endFill=1`

Use the smallest style change that satisfies the request. Preserve custom styles from an existing file instead of normalizing them.

## PNG previews and embedded `.drawio.png` sources

The verifier accepts `.drawio.png` files produced by draw.io and extracts their embedded `mxfile` XML from PNG text metadata before validating or rendering them. The installed desktop app also includes a command-line exporter; use it to render a temporary PNG after creating or editing a diagram, especially when checking that arrows visibly meet their boxes:

```bash
preview_dir="$(mktemp -d "${TMPDIR:-/tmp}/drawio-preview.XXXXXX")"
preview="$preview_dir/diagram.png"
/Applications/draw.io.app/Contents/MacOS/draw.io \
  --disable-update --export --format png --output "$preview" \
  --size diagram --theme light --border 10 --page-index 1 \
  path/to/diagram.drawio
```

Use the image-capable `read` tool on `$preview` and inspect the rendered diagram. Confirm every arrowhead and connector endpoint visibly touches its intended box or shape. If an endpoint floats, points to the wrong shape, or is clipped, fix the XML and export again. For a multi-page file, render the requested page with `--page-index` and inspect each requested page separately. The PNG is a derived preview: do not edit it or treat it as the source of truth; remove the temporary preview directory when inspection is complete unless the user explicitly requests the PNG as an output.

## Programmatic validation

Use the bundled standard-library validator at `scripts/validate-drawio.py` before considering a diagram complete. Run these commands from this skill directory (or use the absolute path to the script):

```bash
cd ~/.pi/agent/skills/drawio-xml
python3 scripts/validate-drawio.py \
  --require-render --strict /path/to/diagram.drawio
```

The validator first checks the XML graph, then asks the installed draw.io desktop CLI to render each page to SVG and checks the rendered geometry. It reports human-readable findings and exits nonzero on failure. Use `--json` for CI or downstream agents:

```bash
cd ~/.pi/agent/skills/drawio-xml
python3 scripts/validate-drawio.py \
  --require-render --strict --json /path/to/diagram.drawio
```

Checks include:

- valid uncompressed `<mxfile>`/`<diagram>`/`<mxGraphModel>`/`<root>` structure;
- required root cells, unique page/cell IDs, valid parents, and no parent cycles;
- finite, non-negative vertex geometry and required edge geometry;
- every connected edge has `source` and `target` IDs resolving to vertex shapes, with relative geometry;
- hidden endpoints, self-loops, zero-size shapes, and untyped cells as warnings;
- positive-area overlap between unrelated visible boxes/shapes;
- XML-estimated edge routes intersecting unrelated boxes;
- crossings between unrelated edge routes as warnings;
- actual SVG-rendered shape bounds and edge routes, including disconnected endpoints, awkward box-corner attachments, rendered edge/box collisions, and collinear connector overlaps;
- rendered vertex labels staying inside their owning boxes, including HTML labels and explicitly parented text labels;
- edge labels staying on or close to their own connector and avoiding visible boxes, arrowheads, and unrelated connector routes (while allowing a label to sit on its own main stroke);
- nearby left/right-aligned standalone boundary annotations (such as memory addresses) lining up with the shape boundary they describe. Other standalone `text` vertices remain annotations unless they are explicitly parented to a box.

Use `--no-render` only when draw.io is unavailable or when a fast XML/static-geometry check is specifically desired; label placement and label collision checks use rendered SVG geometry. Use `--allow-floating` only for diagrams that intentionally contain floating connectors. `--strict` turns warnings (including edge crossings and intentional-quality concerns) into failures. `--render-dir DIR` keeps the generated per-page SVGs for debugging; otherwise they are temporary. `--label-tolerance N` controls the permitted rendered label overflow beyond a box (default: 1 pixel).

The validator is intentionally conservative: container/swimlane children are allowed to overlap their ancestor, and edges are allowed to touch their own source/target shapes. Unrelated boxes and connector crossings are not silently accepted.

## Workflow

1. **Identify the target.** Locate the requested `.drawio`, `.drawio.xml`, or `.drawio.png` file. If it exists, read the complete XML before editing; for `.drawio.png`, extract/read its embedded XML through the verifier and identify the relevant page, cell IDs, parents, sources, and targets.
2. **Plan the graph.** Translate the requested concepts into vertices, edges, labels, pages, and approximate coordinates. Reuse existing cells and IDs for edits. Choose new IDs that do not collide.
3. **Write the XML.** Make the smallest targeted edit with `edit` when possible. Use `write` for a new file. Keep the document readable and uncompressed.
4. **Run programmatic validation.** From the skill directory, run `python3 scripts/validate-drawio.py --require-render --strict` and fix every reported error or warning. Use `--render-dir` when debugging a geometry finding.
5. **Export and inspect a PNG preview.** Use the installed draw.io exporter above, then use `read` on the PNG. Confirm connectors and arrowheads visibly touch their intended boxes/shapes; fix and re-export if they do not.
6. **Validate XML syntax independently.** Prefer the system parser:

    ```bash
    xmllint --noout path/to/diagram.drawio
    ```

    If `xmllint` is unavailable, use another local XML parser rather than assuming the file is valid.

7. **Open in draw.io when useful.** On this Mac:

    ```bash
    open -a "/Applications/draw.io.app" -- path/to/diagram.drawio
    ```

    Use the application for optional interactive confirmation, not as the editing mechanism. Do not overwrite the source with a compressed export.

8. **Report the result.** State the file path, pages/cells changed, and validation performed. Mention the PNG preview only if it was actually rendered and inspected.

## Editing safeguards

- Preserve all unrelated pages, cells, attributes, custom shapes, links, and metadata.
- Do not renumber IDs just to make them sequential; that creates noisy diffs and can break references.
- Do not delete a cell until its incoming and outgoing edges and child cells have been considered.
- Keep page names and diagram IDs stable unless the request requires a rename.
- Do not use raw ampersands in labels or URLs. Escape query strings such as `?a=1&b=2` as `?a=1&amp;b=2`.
- Do not put comments, Markdown, or explanatory prose inside the `.drawio` file.
- Avoid reformatting an entire existing file when a local edit will do; draw.io may rewrite formatting after a GUI save, so inspect the diff afterward.

## Troubleshooting

If draw.io reports a corrupt or blank diagram, check these first:

1. The `<diagram>` element contains a real `<mxGraphModel>`, not compressed text.
2. XML entities are escaped, especially `&` in labels, URLs, and styles.
3. The page contains both `id="0"` and `id="1" parent="0"` root cells.
4. No two cells share an ID.
5. Every cell has a valid `parent`; every edge reference points to an existing cell.
6. The XML was not truncated and has matching closing tags.
7. Every expected arrow has both `source` and `target`; each points to the box or shape it should touch, rather than to a layer root or a nonexistent ID.
8. Styles use draw.io key/value syntax and valid cell attributes (`vertex="1"` or `edge="1"`).

If the request requires an image, PDF, SVG, or another export, treat that as a separate explicit task. A PNG may be generated for visual inspection as described above, but the normal source and deliverable of this skill is the editable, uncompressed draw.io XML.
