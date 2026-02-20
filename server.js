const express = require("express");
const { readPsd, writePsdBuffer, initializeCanvas } = require("ag-psd");
const { createCanvas } = require("canvas");
const fetch = require("node-fetch");
const { createCanvas: createCanvasNode, loadImage } = require("canvas");

// Initialize ag-psd with node-canvas (required for image data handling)
initializeCanvas(createCanvas);

const app = express();
app.use(express.json({ limit: "50mb" }));

// ─── Health Check ─────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "2.0" });
});

// ─── Main Endpoint ────────────────────────────────────
app.post("/generate", async (req, res) => {
  try {
    const {
      template_url,
      header_text,
      subheader_text,
      image_url,
      color_hex,
      background_color_hex,
      export_format = "psd",
    } = req.body;

    if (!template_url) {
      return res.status(400).json({ error: "template_url is required" });
    }

    const startTime = Date.now();
    console.log(`[generate] Starting...`);

    // 1. Download the template PSD
    console.log(`[generate] Downloading template...`);
    const templateResponse = await fetch(template_url);
    if (!templateResponse.ok) {
      throw new Error(`Failed to download template: ${templateResponse.status}`);
    }
    const templateBuffer = await templateResponse.buffer();

    // 2. Read the PSD (useImageData to preserve alpha/colors)
    console.log(`[generate] Parsing PSD...`);
    const psd = readPsd(templateBuffer, { useImageData: true });

    // 3. Apply modifications
    console.log(`[generate] Applying changes...`);

    // Helper: find a layer by name (searches recursively)
    function findLayer(layers, name) {
      if (!layers) return null;
      for (const layer of layers) {
        if (layer.name === name) return layer;
        if (layer.children) {
          const found = findLayer(layer.children, name);
          if (found) return found;
        }
      }
      return null;
    }

    // Helper: create solid color imageData for a layer
    function createColorFill(width, height, hexColor) {
      const r = parseInt(hexColor.slice(1, 3), 16);
      const g = parseInt(hexColor.slice(3, 5), 16);
      const b = parseInt(hexColor.slice(5, 7), 16);

      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        data[i * 4 + 0] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = 255; // fully opaque
      }
      return { width, height, data };
    }

    // ── A. Update header text ──
    if (header_text) {
      const layer = findLayer(psd.children, "header");
      if (layer && layer.text) {
        layer.text.text = header_text;
        // Clear cached bitmap so Photoshop re-renders it
        layer.canvas = undefined;
        layer.imageData = undefined;
        console.log(`  ✓ header → "${header_text}"`);
      } else {
        console.log(`  ⚠ "header" layer not found or not a text layer`);
      }
    }

    // ── B. Update subheader text ──
    if (subheader_text) {
      const layer = findLayer(psd.children, "subheader");
      if (layer && layer.text) {
        layer.text.text = subheader_text;
        layer.canvas = undefined;
        layer.imageData = undefined;
        console.log(`  ✓ subheader → "${subheader_text}"`);
      } else {
        console.log(`  ⚠ "subheader" layer not found or not a text layer`);
      }
    }

    // ── C. Update color_block ──
    if (color_hex) {
      const layer = findLayer(psd.children, "color_block");
      if (layer) {
        const w = (layer.right || 0) - (layer.left || 0);
        const h = (layer.bottom || 0) - (layer.top || 0);
        if (w > 0 && h > 0) {
          layer.imageData = createColorFill(w, h, color_hex);
          layer.canvas = undefined;
          console.log(`  ✓ color_block → ${color_hex} (${w}x${h})`);
        }
      } else {
        console.log(`  ⚠ "color_block" layer not found`);
      }
    }

    // ── D. Update background_block ──
    if (background_color_hex) {
      const layer = findLayer(psd.children, "background_block");
      if (layer) {
        const w = (layer.right || 0) - (layer.left || 0);
        const h = (layer.bottom || 0) - (layer.top || 0);
        if (w > 0 && h > 0) {
          layer.imageData = createColorFill(w, h, background_color_hex);
          layer.canvas = undefined;
          console.log(`  ✓ background_block → ${background_color_hex}`);
        }
      } else {
        console.log(`  ⚠ "background_block" layer not found`);
      }
    }

    // ── E. Replace image_block ──
    if (image_url) {
      const layer = findLayer(psd.children, "image_block");
      if (layer) {
        try {
          // Download the new image
          const imgResponse = await fetch(image_url);
          const imgBuffer = await imgResponse.buffer();

          // Load into canvas
          const img = await loadImage(imgBuffer);

          // Get layer dimensions
          const layerW = (layer.right || 0) - (layer.left || 0);
          const layerH = (layer.bottom || 0) - (layer.top || 0);
          const targetW = layerW > 0 ? layerW : img.width;
          const targetH = layerH > 0 ? layerH : img.height;

          // Draw image scaled to fit the layer dimensions
          const canvas = createCanvasNode(targetW, targetH);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, targetW, targetH);

          // Get image data and assign to layer
          const imgData = ctx.getImageData(0, 0, targetW, targetH);
          layer.imageData = {
            width: targetW,
            height: targetH,
            data: new Uint8ClampedArray(imgData.data),
          };
          layer.canvas = undefined;

          // Update layer bounds if dimensions changed
          layer.right = (layer.left || 0) + targetW;
          layer.bottom = (layer.top || 0) + targetH;

          console.log(`  ✓ image_block → ${image_url} (${targetW}x${targetH})`);
        } catch (imgErr) {
          console.log(`  ⚠ Failed to load image: ${imgErr.message}`);
        }
      } else {
        console.log(`  ⚠ "image_block" layer not found`);
      }
    }

    // 4. Write the modified PSD
    console.log(`[generate] Writing PSD...`);
    const outputBuffer = writePsdBuffer(psd, {
      invalidateTextLayers: true,  // Forces Photoshop to re-render text
      trimImageData: true,
    });

    const elapsed = Date.now() - startTime;
    console.log(`[generate] Done in ${elapsed}ms (${outputBuffer.length} bytes)`);

    // 5. Send back
    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="output.psd"',
      "Content-Length": outputBuffer.length,
    });
    res.send(outputBuffer);

  } catch (error) {
    console.error("[generate] Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Debug: Inspect PSD structure ─────────────────────
app.post("/inspect", async (req, res) => {
  try {
    const { template_url } = req.body;
    const response = await fetch(template_url);
    const buffer = await response.buffer();
    const psd = readPsd(buffer, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    });

    function mapLayers(layers) {
      if (!layers) return [];
      return layers.map((l) => ({
        name: l.name,
        type: l.text ? "text" : l.children ? "group" : "pixel",
        text: l.text ? l.text.text : undefined,
        bounds: {
          left: l.left, top: l.top,
          right: l.right, bottom: l.bottom,
          width: (l.right || 0) - (l.left || 0),
          height: (l.bottom || 0) - (l.top || 0),
        },
        visible: l.hidden ? false : true,
        children: l.children ? mapLayers(l.children) : undefined,
      }));
    }

    res.json({
      width: psd.width,
      height: psd.height,
      layers: mapLayers(psd.children),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Start ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PSD Generator running on port ${PORT}`);
});
