#!/usr/bin/env node
/**
 * Generates GitHub stats SVG cards (stats + top languages) including
 * private repository contributions, using the GitHub GraphQL API.
 *
 * Usage:
 *   GH_STATS_TOKEN=<pat> node scripts/generate-stats.mjs [--user oleoz1n] [--out assets]
 *   node scripts/generate-stats.mjs --mock   (render with sample data, no API calls)
 *
 * The token needs `repo` scope (classic PAT) or read access to your private
 * repos (fine-grained) so private commits and languages are counted.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const MOCK = args.includes("--mock");
const USER = getArg("user", "oleoz1n");
const OUT_DIR = getArg("out", "assets");
const TOKEN = process.env.GH_STATS_TOKEN || process.env.GITHUB_TOKEN;

// github_dark_dimmed theme (same palette as github-readme-stats)
const THEME = {
  bg: "#22272e",
  border: "#444c56",
  title: "#539bf5",
  icon: "#539bf5",
  text: "#adbac7",
  muted: "#768390",
};

// Octicons (16px), MIT licensed — https://github.com/primer/octicons
const ICONS = {
  star: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z",
  commit: "M10.5 7.75a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm1.43.75a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Z",
  pr: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  issue: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm9 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm-.25-6.25a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 1.5 0v-3.5Z",
  repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-generator",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchAllTimePublicCommits(login) {
  // Search API counts all-time commits in public repos; private commits from
  // the last year come from restrictedContributionsCount below.
  const res = await fetch(
    `https://api.github.com/search/commits?q=author:${encodeURIComponent(login)}&per_page=1`,
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "profile-stats-generator",
      },
    }
  );
  if (!res.ok) throw new Error(`Search API HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).total_count;
}

async function fetchLanguagesByCommits(login) {
  // Weight each repo's languages by how many commits YOU made in it, covering
  // every repo you contributed to (own, org and private), not just owned ones.
  // contributionsCollection is limited to 1-year windows, so we query one
  // window per year since the account was created.
  const { user: meta } = await graphql(
    `query ($login: String!) { user(login: $login) { createdAt } }`,
    { login }
  );
  const startYear = new Date(meta.createdAt).getUTCFullYear();
  const endYear = new Date().getUTCFullYear();

  const windows = [];
  for (let y = startYear; y <= endYear; y++) {
    windows.push(`
      y${y}: contributionsCollection(
        from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z"
      ) {
        commitContributionsByRepository(maxRepositories: 100) {
          contributions { totalCount }
          repository {
            nameWithOwner
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name color } }
            }
          }
        }
      }`);
  }
  const { user } = await graphql(
    `query ($login: String!) { user(login: $login) { ${windows.join("\n")} } }`,
    { login }
  );

  const langWeights = new Map();
  for (const window of Object.values(user)) {
    for (const { contributions, repository } of window.commitContributionsByRepository) {
      const edges = repository.languages.edges;
      const repoSize = edges.reduce((s, e) => s + e.size, 0);
      if (!repoSize) continue;
      for (const { size, node } of edges) {
        const cur = langWeights.get(node.name) || { weight: 0, color: node.color || "#8b949e" };
        cur.weight += contributions.totalCount * (size / repoSize);
        langWeights.set(node.name, cur);
      }
    }
  }
  const total = [...langWeights.values()].reduce((s, l) => s + l.weight, 0);
  return [...langWeights.entries()]
    .map(([name, { weight, color }]) => ({ name, color, pct: (weight / total) * 100 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 8);
}

async function fetchStats(login) {
  const query = `
    query ($login: String!) {
      user(login: $login) {
        name
        contributionsCollection {
          totalCommitContributions
          restrictedContributionsCount
        }
        pullRequests { totalCount }
        issues { totalCount }
        repositoriesContributedTo(
          contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]
        ) { totalCount }
        repositories(
          first: 100
          ownerAffiliations: OWNER
          orderBy: { field: STARGAZERS, direction: DESC }
        ) {
          nodes { stargazerCount }
        }
      }
    }`;
  const { user } = await graphql(query, { login });

  const stars = user.repositories.nodes.reduce((sum, r) => sum + r.stargazerCount, 0);

  const publicCommits = await fetchAllTimePublicCommits(login);
  const privateCommits = user.contributionsCollection.restrictedContributionsCount;

  const languages = await fetchLanguagesByCommits(login);

  return {
    name: user.name?.trim() || login,
    stars,
    commits: publicCommits + privateCommits,
    prs: user.pullRequests.totalCount,
    issues: user.issues.totalCount,
    contributedTo: user.repositoriesContributedTo.totalCount,
    languages,
  };
}

function statRow(icon, label, value, y) {
  return `
  <g transform="translate(25, ${y})">
    <path d="${ICONS[icon]}" fill="${THEME.icon}" transform="scale(1.05)"/>
    <text x="26" y="12.5" class="stat">${esc(label)}:</text>
    <text x="220" y="12.5" class="stat bold">${esc(value)}</text>
  </g>`;
}

function renderStatsCard(s) {
  const rows = [
    statRow("star", "Total Stars Earned", fmt(s.stars), 55),
    statRow("commit", "Total Commits", fmt(s.commits), 80),
    statRow("pr", "Total PRs", fmt(s.prs), 105),
    statRow("issue", "Total Issues", fmt(s.issues), 130),
    statRow("repo", "Contributed to", fmt(s.contributedTo), 155),
  ].join("");

  return `<svg width="360" height="185" viewBox="0 0 360 185" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(s.name)}'s GitHub stats">
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.title}; }
    .stat { font: 400 14px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; }
    .bold { font-weight: 700; }
  </style>
  <rect x="0.5" y="0.5" width="359" height="184" rx="4.5" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text x="25" y="35" class="title">${esc(s.name)}'s GitHub Stats</text>${rows}
</svg>`;
}

function renderLangsCard(languages) {
  const barW = 310;
  let x = 0;
  const segments = languages
    .map((l) => {
      const w = Math.max((l.pct / 100) * barW, 2);
      const seg = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="8" fill="${l.color}"/>`;
      x += w;
      return seg;
    })
    .join("");

  const colH = Math.ceil(languages.length / 2);
  const legend = languages
    .map((l, i) => {
      const col = Math.floor(i / colH);
      const row = i % colH;
      return `
  <g transform="translate(${25 + col * 165}, ${85 + row * 24})">
    <circle cx="5" cy="6" r="5" fill="${l.color}"/>
    <text x="16" y="10" class="lang">${esc(l.name)} <tspan fill="${THEME.muted}">${l.pct.toFixed(1)}%</tspan></text>
  </g>`;
    })
    .join("");

  const height = 85 + colH * 24 + 15;
  return `<svg width="360" height="${height}" viewBox="0 0 360 ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Most used languages">
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.title}; }
    .lang { font: 400 12px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.text}; }
  </style>
  <rect x="0.5" y="0.5" width="359" height="${height - 1}" rx="4.5" fill="${THEME.bg}" stroke="${THEME.border}"/>
  <text x="25" y="35" class="title">Most Used Languages</text>
  <g transform="translate(25, 55)">
    <clipPath id="bar"><rect width="${barW}" height="8" rx="4"/></clipPath>
    <g clip-path="url(#bar)">${segments}</g>
  </g>${legend}
</svg>`;
}

const MOCK_STATS = {
  name: "Leonardo Guerra",
  stars: 12,
  commits: 1234,
  prs: 56,
  issues: 7,
  contributedTo: 9,
  languages: [
    { name: "TypeScript", color: "#3178c6", pct: 38.2 },
    { name: "Java", color: "#b07219", pct: 22.1 },
    { name: "C#", color: "#178600", pct: 12.4 },
    { name: "Python", color: "#3572A5", pct: 10.0 },
    { name: "Kotlin", color: "#A97BFF", pct: 8.3 },
    { name: "Rust", color: "#dea584", pct: 5.0 },
    { name: "C", color: "#555555", pct: 2.5 },
    { name: "HTML", color: "#e34c26", pct: 1.5 },
  ],
};

async function main() {
  if (!MOCK && !TOKEN) {
    console.error("Missing GH_STATS_TOKEN (or GITHUB_TOKEN) environment variable.");
    process.exit(1);
  }
  const stats = MOCK ? MOCK_STATS : await fetchStats(USER);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "github-stats.svg"), renderStatsCard(stats));
  await writeFile(path.join(OUT_DIR, "top-langs.svg"), renderLangsCard(stats.languages));
  console.log(
    `Generated ${OUT_DIR}/github-stats.svg and ${OUT_DIR}/top-langs.svg` +
      (MOCK ? " (mock data)" : ` for ${USER}: ${stats.commits} commits incl. private`)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
