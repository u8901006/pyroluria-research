import { readFileSync, writeFileSync, existsSync } from "fs";
import { parseArgs } from "node:util";

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

const SEARCH_QUERIES = [
  `(pyroluria[Title/Abstract] OR pyrroluria[Title/Abstract] OR kryptopyrroluria[Title/Abstract] OR "pyrrole disorder"[Title/Abstract] OR "Mauve factor"[Title/Abstract] OR "urinary pyrrole*"[Title/Abstract] OR "urinary kryptopyrrole*"[Title/Abstract] OR hydroxyhemopyrrolin[Title/Abstract] OR hydroxyhemepyrrolin[Title/Abstract] OR HPL[Title/Abstract])`,
  `(pyroluria[Title/Abstract] OR pyrroluria[Title/Abstract] OR kryptopyrroluria[Title/Abstract] OR "Mauve factor"[Title/Abstract] OR hydroxyhemopyrrolin[Title/Abstract] OR hydroxyhemepyrrolin[Title/Abstract] OR "urinary pyrrole*"[Title/Abstract]) AND (schizophrenia[Title/Abstract] OR psychosis[Title/Abstract] OR anxiety[Title/Abstract] OR depression[Title/Abstract] OR ADHD[Title/Abstract] OR autism[Title/Abstract] OR alcoholism[Title/Abstract] OR "mental disorder*"[Title/Abstract])`,
  `(pyroluria[Title/Abstract] OR pyrroluria[Title/Abstract] OR kryptopyrroluria[Title/Abstract] OR "pyrrole disorder"[Title/Abstract] OR "Mauve factor"[Title/Abstract] OR hydroxyhemopyrrolin[Title/Abstract] OR hydroxyhemepyrrolin[Title/Abstract]) AND (zinc[Title/Abstract] OR "Zinc"[MeSH Terms] OR "vitamin B6"[Title/Abstract] OR pyridoxine[Title/Abstract] OR "Vitamin B 6"[MeSH Terms] OR "pyridoxal phosphate"[Title/Abstract] OR P5P[Title/Abstract] OR micronutrient*[Title/Abstract] OR supplement*[Title/Abstract])`,
  `("Mauve factor"[Title/Abstract] OR kryptopyrrole[Title/Abstract] OR hydroxyhemopyrrolin[Title/Abstract] OR hydroxyhemepyrrolin[Title/Abstract] OR "urinary pyrrole*"[Title/Abstract] OR "urinary kryptopyrrole*"[Title/Abstract]) AND (assay[Title/Abstract] OR validation[Title/Abstract] OR "Ehrlich reaction"[Title/Abstract] OR "Ehrlich reagent"[Title/Abstract] OR chromatography[Title/Abstract] OR "mass spectrometry"[Title/Abstract] OR LC-MS[Title/Abstract] OR GC-MS[Title/Abstract])`,
  `("urinary pyrrole*"[Title/Abstract] OR hydroxyhemopyrrolin[Title/Abstract] OR hydroxyhemepyrrolin[Title/Abstract] OR HPL[Title/Abstract] OR "Mauve factor"[Title/Abstract]) AND ("oxidative stress"[Title/Abstract] OR "Oxidative Stress"[MeSH Terms] OR ROS[Title/Abstract] OR "reactive oxygen species"[Title/Abstract] OR heme[Title/Abstract] OR haem[Title/Abstract] OR bilirubin[Title/Abstract] OR porphyrin*[Title/Abstract] OR glutathione[Title/Abstract])`,
  `(pyroluria OR pyrroluria OR kryptopyrroluria OR "Mauve factor" OR hydroxyhemopyrrolin OR hydroxyhemepyrrolin) AND (review OR systematic OR validity OR "diagnostic accuracy" OR "sensitivity and specificity" OR reproducibility OR "false positive" OR "placebo-controlled")`,
  `("zinc deficiency"[Title/Abstract] OR "vitamin B6 deficiency"[Title/Abstract] OR pyridoxine[Title/Abstract] OR "pyridoxal phosphate"[Title/Abstract]) AND (anxiety[Title/Abstract] OR depression[Title/Abstract] OR schizophrenia[Title/Abstract] OR ADHD[Title/Abstract] OR autism[Title/Abstract]) AND (review[Publication Type] OR meta-analysis[Publication Type] OR randomized[Title/Abstract] OR trial[Title/Abstract])`,
  `("Mauve factor"[Title/Abstract] OR malvaria[Title/Abstract] OR kryptopyrrole[Title/Abstract] OR hemopyrrole[Title/Abstract] OR "Ehrlich-positive"[Title/Abstract]) AND (schizophrenia[Title/Abstract] OR schizophrenic[Title/Abstract] OR psychosis[Title/Abstract])`,
];

function buildDateFilter(days) {
  const lookback = new Date(Date.now() - days * 86400000);
  const yyyy = lookback.getFullYear();
  const mm = String(lookback.getMonth() + 1).padStart(2, "0");
  const dd = String(lookback.getDate()).padStart(2, "0");
  return `"${yyyy}/${mm}/${dd}"[Date - Publication] : "3000"[Date - Publication]`;
}

async function searchPapers(query, retmax = 50) {
  const url = new URL(PUBMED_SEARCH);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("term", query);
  url.searchParams.set("retmax", String(retmax));
  url.searchParams.set("sort", "date");
  url.searchParams.set("retmode", "json");
  try {
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "PyroluriaResearchBot/1.0 (research aggregator)" },
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const url = new URL(PUBMED_FETCH);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", pmids.join(","));
  url.searchParams.set("retmode", "xml");
  try {
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "PyroluriaResearchBot/1.0 (research aggregator)" },
      signal: AbortSignal.timeout(60000),
    });
    const xml = await resp.text();
    return parseXml(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function parseXml(xml) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    const abstractParts = [];
    const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let absMatch;
    while ((absMatch = absRegex.exec(block)) !== null) {
      const labelMatch = absMatch[0].match(/Label="([^"]+)"/);
      const label = labelMatch ? labelMatch[1] : "";
      const text = absMatch[1].replace(/<[^>]+>/g, "").trim();
      if (text) {
        abstractParts.push(label ? `${label}: ${text}` : text);
      }
    }
    const abstract = abstractParts.join(" ").slice(0, 2000);

    const journalMatch = block.match(/<Title>([\s\S]*?)<\/Title>/);
    const journal = journalMatch ? journalMatch[1].trim() : "";

    const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidMatch ? pmidMatch[1] : "";

    let dateStr = "";
    const yearMatch = block.match(/<Year>(\d+)<\/Year>/);
    const monthMatch = block.match(/<Month>([^<]+)<\/Month>/);
    const dayMatch = block.match(/<Day>(\d+)<\/Day>/);
    if (yearMatch) {
      const parts = [yearMatch[1]];
      if (monthMatch) parts.push(monthMatch[1]);
      if (dayMatch) parts.push(dayMatch[1]);
      dateStr = parts.join(" ");
    }

    const keywords = [];
    const kwRegex = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    let kwMatch;
    while ((kwMatch = kwRegex.exec(block)) !== null) {
      if (kwMatch[1].trim()) keywords.push(kwMatch[1].trim());
    }

    if (title) {
      papers.push({
        pmid,
        title,
        journal,
        date: dateStr,
        abstract,
        url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
        keywords,
      });
    }
  }
  return papers;
}

function loadTracked(trackedPath) {
  if (existsSync(trackedPath)) {
    try {
      return JSON.parse(readFileSync(trackedPath, "utf-8"));
    } catch {
      return { lastUpdated: "", summarizedPmids: {} };
    }
  }
  return { lastUpdated: "", summarizedPmids: {} };
}

function parseArgsCli() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 40, output: "papers.json", tracked: "tracked-papers.json" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) opts.days = parseInt(args[++i]);
    else if (args[i] === "--max-papers" && args[i + 1]) opts.maxPapers = parseInt(args[++i]);
    else if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    else if (args[i] === "--tracked" && args[i + 1]) opts.tracked = args[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgsCli();
  const dateFilter = buildDateFilter(opts.days);
  const tracked = loadTracked(opts.tracked);
  const allPmids = new Set();

  for (const query of SEARCH_QUERIES) {
    const fullQuery = `(${query}) AND ${dateFilter}`;
    console.error(`[INFO] Searching PubMed...`);
    const pmids = await searchPapers(fullQuery, opts.maxPapers);
    pmids.forEach((id) => allPmids.add(id));
    if (allPmids.size > 0) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const uniquePmids = [...allPmids];
  const newPmids = uniquePmids.filter((id) => !tracked.summarizedPmids[id]);
  console.error(`[INFO] Found ${uniquePmids.length} unique papers, ${newPmids.length} new`);

  let papers = [];
  if (newPmids.length > 0) {
    papers = await fetchDetails(newPmids);
  }

  const now = new Date(Date.now() + 8 * 3600000);
  const dateStr = now.toISOString().slice(0, 10);

  const output = {
    date: dateStr,
    count: papers.length,
    papers,
  };

  writeFileSync(opts.output, JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved ${papers.length} papers to ${opts.output}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
