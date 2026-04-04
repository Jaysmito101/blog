// @ts-check

import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

const normalizedBase = (process.env.SITE_BASE_PATH || "/")
  .replace(/^\/?/, "/")
  .replace(/\/?$/, "/");

export default defineConfig({
  site: "https://blog.jaysmito.dev",
  base: normalizedBase,
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
  },
  integrations: [
    mdx({
      remarkPlugins: [remarkMath],
      rehypePlugins: [rehypeKatex],
    }),
    sitemap(),
  ],
});
