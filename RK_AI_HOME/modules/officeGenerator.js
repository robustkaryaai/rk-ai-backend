import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } from "docx";
import pptxgen from "pptxgenjs";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { callGemini } from "../services/gemini.js";
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename, generateSmartFilename } from "../utils/fileNaming.js";
import { logInfo, logError } from "../utils/logger.js";

// Clean JSON response from Gemini
function cleanJSON(raw) {
  let text = (raw || "").trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    text = text.substring(firstBrace, lastBrace + 1);
  }
  return text;
}

/**
 * 📄 Generates Professional DOCX document using strict DOCX rules
 */
export async function createProfessionalDocx(prompt, slug, type = "document") {
  logInfo(`[DOCX Generator] Generating structured docx for: "${prompt}"`);

  const systemPrompt = `You are a professional document architect following strict publishing standards.
Generate structured content for a ${type} based on the user's request.
Return ONLY valid JSON matching this schema:
{
  "title": "Title of Document",
  "subtitle": "Subtitle or Category",
  "sections": [
    {
      "heading": "Section Heading",
      "level": 1, // 1 for H1, 2 for H2
      "paragraphs": ["First paragraph text...", "Second paragraph text..."],
      "bullets": ["Bullet point 1", "Bullet point 2"],
      "table": {
        "headers": ["Col 1", "Col 2", "Col 3"],
        "rows": [
          ["Val 1", "Val 2", "Val 3"],
          ["Val 4", "Val 5", "Val 6"]
        ]
      }
    }
  ]
}
Rules:
- Professional tone, complete substantive content (no filler, no "Insert here", no placeholders).
- Minimum 3 comprehensive sections.
- Return ONLY valid JSON, no markdown fences.`;

  const rawJson = await callGemini(systemPrompt, "", prompt);
  let parsed;
  try {
    parsed = JSON.parse(cleanJSON(rawJson));
  } catch (e) {
    logError("[DOCX Generator] JSON parsing failed, using fallback parser:", e);
    parsed = {
      title: prompt,
      sections: [{ heading: "Overview", paragraphs: [rawJson.replace(/```[a-z]*\n?/g, "").trim()] }]
    };
  }

  const docChildren = [];

  // Title
  if (parsed.title) {
    docChildren.push(
      new Paragraph({
        text: parsed.title,
        heading: HeadingLevel.TITLE,
        spacing: { after: 120 }
      })
    );
  }

  // Subtitle
  if (parsed.subtitle) {
    docChildren.push(
      new Paragraph({
        children: [new TextRun({ text: parsed.subtitle, italics: true, color: "555555" })],
        spacing: { after: 300 }
      })
    );
  }

  // Sections
  for (const sec of parsed.sections || []) {
    if (sec.heading) {
      docChildren.push(
        new Paragraph({
          text: sec.heading,
          heading: sec.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 }
        })
      );
    }

    if (Array.isArray(sec.paragraphs)) {
      for (const p of sec.paragraphs) {
        if (p && p.trim()) {
          docChildren.push(
            new Paragraph({
              children: [new TextRun({ text: p.trim() })],
              spacing: { after: 140 }
            })
          );
        }
      }
    }

    if (Array.isArray(sec.bullets)) {
      for (const b of sec.bullets) {
        if (b && b.trim()) {
          docChildren.push(
            new Paragraph({
              children: [new TextRun({ text: `• ${b.trim()}` })],
              spacing: { after: 80 },
              indent: { left: 720 }
            })
          );
        }
      }
    }

    if (sec.table && Array.isArray(sec.table.headers) && Array.isArray(sec.table.rows)) {
      const colCount = sec.table.headers.length || 1;
      const colWidthDxa = Math.floor(9000 / colCount);

      const tableRows = [
        new TableRow({
          children: sec.table.headers.map(h => new TableCell({
            width: { size: colWidthDxa, type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun({ text: String(h), bold: true })] })]
          }))
        }),
        ...sec.table.rows.map(row => new TableRow({
          children: row.map(cell => new TableCell({
            width: { size: colWidthDxa, type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun({ text: String(cell) })] })]
          }))
        }))
      ];

      docChildren.push(
        new Table({
          rows: tableRows,
          width: { size: 9000, type: WidthType.DXA }
        })
      );
      docChildren.push(new Paragraph({ spacing: { after: 200 } }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: { size: { width: 12240, height: 15840 } } // US Letter Standard
      },
      children: docChildren
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = parsed?.title
    ? `${parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").substring(0, 40)}-${Date.now()}.docx`
    : await generateSmartFilename(prompt, type, "docx", slug);
  await saveFileToSlug(slug, filename, buffer);
  logInfo(`[DOCX Generator] ✅ Saved to storage: ${filename}`);

  return { docx: filename };
}

/**
 * 📊 Generates Styled Excel Spreadsheet (.xlsx) for grading sheets, marks, and timetables
 */
export async function createProfessionalExcel(prompt, slug, type = "spreadsheet") {
  logInfo(`[Excel Generator] Generating structured xlsx for: "${prompt}"`);

  const systemPrompt = `You are an expert data analyst and spreadsheet designer.
Generate structured tabular data for a ${type} based on the user's prompt.
Return ONLY valid JSON matching this schema:
{
  "sheetName": "Marksheet or Timetable",
  "title": "Sheet Title",
  "columns": [
    { "header": "Column Header", "key": "key1", "width": 20 }
  ],
  "rows": [
    { "key1": "Value 1", "key2": "Value 2" }
  ]
}
Rules:
- Complete rows with realistic values, student names, grades, or timetable intervals.
- Minimum 5 to 10 rows.
- No markdown, return ONLY valid JSON.`;

  const rawJson = await callGemini(systemPrompt, "", prompt);
  let parsed;
  try {
    parsed = JSON.parse(cleanJSON(rawJson));
  } catch (e) {
    logError("[Excel Generator] JSON parsing failed:", e);
    parsed = {
      sheetName: "Sheet1",
      columns: [{ header: "Content", key: "c1", width: 50 }],
      rows: [{ c1: rawJson }]
    };
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "RK AI Assistant";
  const worksheet = workbook.addWorksheet(parsed.sheetName || "Sheet1");

  // Title Row
  if (parsed.title) {
    worksheet.mergeCells("A1:E1");
    const titleCell = worksheet.getCell("A1");
    titleCell.value = parsed.title;
    titleCell.font = { name: "Arial", size: 14, bold: true, color: { argb: "FFFFFFFF" } };
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E2761" } };
    titleCell.alignment = { vertical: "middle", horizontal: "center" };
    worksheet.getRow(1).height = 30;
    worksheet.addRow([]); // Blank spacer
  }

  // Setup columns
  const cols = (parsed.columns || []).map(c => ({
    header: c.header,
    key: c.key,
    width: c.width || 18
  }));
  
  if (cols.length > 0) {
    const headerRow = worksheet.addRow(cols.map(c => c.header));
    headerRow.font = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F3C7E" } };
    headerRow.height = 24;

    for (let i = 1; i <= cols.length; i++) {
      worksheet.getColumn(i).width = cols[i - 1].width;
    }

    for (const r of parsed.rows || []) {
      const rowValues = cols.map(c => r[c.key] !== undefined ? r[c.key] : "");
      const addedRow = worksheet.addRow(rowValues);
      addedRow.height = 20;
      addedRow.border = {
        top: { style: "thin", color: { argb: "FFDDDDDD" } },
        bottom: { style: "thin", color: { argb: "FFDDDDDD" } }
      };
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = parsed?.title || parsed?.sheetName
    ? `${String(parsed.title || parsed.sheetName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").substring(0, 40)}-${Date.now()}.xlsx`
    : await generateSmartFilename(prompt, type, "xlsx", slug);
  await saveFileToSlug(slug, filename, buffer);
  logInfo(`[Excel Generator] ✅ Saved to storage: ${filename}`);

  return { xlsx: filename };
}

/**
 * 📽️ Generates Professional PPTX Slide Deck using PPTXGenJS
 */
export async function createProfessionalPPT(prompt, slug) {
  logInfo(`[PPTX Generator] Generating slide deck for: "${prompt}"`);

  const systemPrompt = `You are an elite slide presentation designer following strict PPTX standards.
Create a structured 5-6 slide presentation deck for the user's prompt.
Return ONLY valid JSON matching this schema:
{
  "theme": "Midnight Executive", // "Midnight Executive" or "Coral Energy" or "Forest & Moss"
  "slides": [
    {
      "title": "Slide Title",
      "subtitle": "Optional Subtitle",
      "bullets": ["Key concise point 1", "Key concise point 2", "Key concise point 3"],
      "speakerNotes": "Spoken presenter notes for this slide"
    }
  ]
}
Rules:
- Slide 1 must be Title Slide (title + subtitle, no bullets).
- Slides 2-5: Topical content, max 3-4 impactful bullet points.
- Last Slide: Summary / Next Steps.
- No markdown, return ONLY valid JSON.`;

  const rawJson = await callGemini(systemPrompt, "", prompt);
  let parsed;
  try {
    parsed = JSON.parse(cleanJSON(rawJson));
  } catch (e) {
    logError("[PPTX Generator] JSON parsing failed:", e);
    parsed = {
      slides: [
        { title: prompt, subtitle: "Presentation Overview", bullets: [] },
        { title: "Key Information", bullets: [rawJson.slice(0, 150)] }
      ]
    };
  }

  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_16x9"; // 10" x 5.625"
  pptx.author = "RK AI Assistant";

  const palette = {
    bgDark: "1E2761",
    bgLight: "F8F9FA",
    titleLight: "FFFFFF",
    titleDark: "1E2761",
    accent: "F96167",
    textDark: "333333",
    textLight: "CADCFC"
  };

  const slides = parsed.slides || [];
  slides.forEach((s, idx) => {
    const slide = pptx.addSlide();
    const isTitle = idx === 0 || idx === slides.length - 1;

    if (isTitle) {
      slide.background = { color: palette.bgDark };
      slide.addText(s.title || "Presentation", {
        x: 0.8,
        y: 1.8,
        w: 8.4,
        h: 1.5,
        fontSize: 36,
        bold: true,
        color: palette.titleLight,
        align: "center",
        valign: "middle"
      });

      if (s.subtitle) {
        slide.addText(s.subtitle, {
          x: 1.0,
          y: 3.4,
          w: 8.0,
          h: 0.8,
          fontSize: 20,
          color: palette.accent,
          align: "center"
        });
      }
    } else {
      slide.background = { color: palette.bgLight };

      // Header Bar
      slide.addShape(pptx.shapes.RECTANGLE, {
        x: 0,
        y: 0,
        w: 10,
        h: 1.1,
        fill: { color: palette.bgDark }
      });

      slide.addText(s.title || "Topic", {
        x: 0.8,
        y: 0.2,
        w: 8.4,
        h: 0.7,
        fontSize: 24,
        bold: true,
        color: palette.titleLight,
        valign: "middle"
      });

      // Bullets
      if (Array.isArray(s.bullets) && s.bullets.length > 0) {
        const textItems = s.bullets.map((b, bIdx) => ({
          text: b,
          options: {
            bullet: true,
            breakLine: bIdx < s.bullets.length - 1,
            fontSize: 16,
            color: palette.textDark,
            paraSpaceAfter: 12
          }
        }));

        slide.addText(textItems, {
          x: 1.0,
          y: 1.8,
          w: 8.0,
          h: 3.2,
          margin: 0
        });
      }
    }

    if (s.speakerNotes) {
      slide.addNotes(s.speakerNotes);
    }
  });

  const buffer = await pptx.write({ outputType: "nodebuffer" });
  const firstSlideTitle = parsed?.slides?.[0]?.title;
  const filename = firstSlideTitle
    ? `${firstSlideTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").substring(0, 40)}-${Date.now()}.pptx`
    : await generateSmartFilename(prompt, "ppt", "pptx", slug);
  await saveFileToSlug(slug, filename, buffer);
  logInfo(`[PPTX Generator] ✅ Saved to storage: ${filename}`);

  return { ppt: filename };
}
