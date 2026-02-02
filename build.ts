#!/usr/bin/env bun
// build.ts - Build completo com auto-detect de dependências e metadados

import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

// ==========================================
// CONFIGURAÇÕES - EDITE AQUI
// ==========================================
const CONFIG = {
  name: "hono-openapi",
  version: "1.2.0", // Será sobrescrito pelo package.json se existir
  description: "OpenAPI schema generator for Hono",
  author: "Matheus Couto",
  license: "MIT",
  repository: "", // Opcional
  keywords: ["hono", "openapi", "schema"],

  // Se true, copia devDependencies do package.json raiz automaticamente
  includeDevDependencies: false,

  // Se true, copia dependencies do package.json raiz automaticamente
  includeDependencies: true,

  // Lista de dependências que devem ser incluídas no bundle (e removidas do package.json final)
  bundledDependencies: [],

  entryFile: "index.ts",
  srcDir: "src",
  distDir: "dist",
  target: "node" as const,

  // Arquivos adicionais para copiar pro dist
  extraFiles: ["LICENSE", "README.md"],
};

// ==========================================
// LÓGICA DO BUILD
// ==========================================

interface BuildTarget {
  entryPath: string;
  outDir: string;
  exportKey: string;
  relDir: string;
}

interface RootPackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  bugs?: string | { url?: string; email?: string };
  homepage?: string;
  [key: string]: any;
}

async function clean() {
  console.log(`🧹 Limpando ${CONFIG.distDir}...`);
  await rm(CONFIG.distDir, { recursive: true, force: true });
  await mkdir(CONFIG.distDir, { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getRootPackageJson(): Promise<RootPackageJson | null> {
  try {
    const content = await readFile("package.json", "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function copyMetadataFiles() {
  console.log("\n📄 Copiando metadados...");

  const readmePath = "README.md";
  const hasReadme = await fileExists(readmePath);

  if (hasReadme) {
    await copyFile(readmePath, path.join(CONFIG.distDir, "README.md"));
    console.log("   ✅ README.md copiado");
  } else {
    console.log("   ⚠️  README.md não encontrado, gerando básico...");
    const basicReadme = `# ${CONFIG.name}

${CONFIG.description}

## Instalação

\`\`\`bash
bun add ${CONFIG.name}
# ou
npm install ${CONFIG.name}
\`\`\`
`;
    await Bun.write(path.join(CONFIG.distDir, "README.md"), basicReadme);
  }

  for (const file of CONFIG.extraFiles) {
    if (file === "README.md") continue; // Já tratado
    if (await fileExists(file)) {
      await copyFile(file, path.join(CONFIG.distDir, file));
      console.log(`   ✅ ${file} copiado`);
    }
  }

  return hasReadme;
}

async function getEntrypoints(): Promise<BuildTarget[]> {
  const glob = new Bun.Glob(`**/${CONFIG.entryFile}`);
  const targets: BuildTarget[] = [];

  for await (const file of glob.scan({ cwd: CONFIG.srcDir })) {
    const relDir = path.dirname(file);
    const entryPath = path.join(CONFIG.srcDir, file);
    const outDir = path.join(CONFIG.distDir, relDir);
    const exportKey = relDir === "." ? "." : `./${relDir.replace(/\\/g, "/")}`;

    targets.push({ entryPath, outDir, exportKey, relDir });
  }

  if (targets.length === 0) {
    throw new Error(`Nenhum ${CONFIG.entryFile} encontrado em ${CONFIG.srcDir}/
`);
  }

  console.log(`📦 Encontrados ${targets.length} entrypoint(s):`);
  targets.forEach((t) => console.log(`   ${t.entryPath} → ${t.exportKey}`));

  return targets;
}

async function buildJS(
  targets: BuildTarget[],
  rootPkg: RootPackageJson | null,
) {
  console.log("\n🔨 Compilando JavaScript...");

  // Identifica quais dependências devem ser externas
  const deps = rootPkg?.dependencies ? Object.keys(rootPkg.dependencies) : [];
  const peerDeps = rootPkg?.peerDependencies
    ? Object.keys(rootPkg.peerDependencies)
    : [];

  // Combine dependencies and peerDependencies for externalization
  const allDeps = [...deps, ...peerDeps];

  const external = allDeps.filter(
    (dep) => !CONFIG.bundledDependencies.includes(dep),
  );

  if (CONFIG.bundledDependencies.length > 0) {
    console.log(`   📦 Bundling: ${CONFIG.bundledDependencies.join(", ")}`);
  }
  if (external.length > 0) {
    console.log(`   🌐 External: ${external.join(", ")}`);
  }

  for (const target of targets) {
    await mkdir(target.outDir, { recursive: true });

    const result = await Bun.build({
      entrypoints: [target.entryPath],
      outdir: target.outDir,
      target: CONFIG.target,
      format: "esm",
      minify: true,
      splitting: false,
      external,
    });

    if (!result.success) {
      console.error(result.logs);
      throw new Error(`Falha ao buildar ${target.entryPath}`);
    }

    const baseName = path.basename(CONFIG.entryFile, ".ts");
    const originalFile = path.join(target.outDir, `${baseName}.js`);
    const finalFile = path.join(target.outDir, "index.js");

    await rename(originalFile, finalFile);
  }

  console.log("✅ JavaScript compilado");
}

async function buildDeclarations(targets: BuildTarget[]) {
  console.log("\n📝 Gerando declarações TypeScript...");

  const allSourceFiles: string[] = [];
  const glob = new Bun.Glob("**/*.ts");

  for await (const file of glob.scan({ cwd: CONFIG.srcDir })) {
    if (
      file.includes(".test.") ||
      file.includes(".spec.") ||
      file.includes("__tests__")
    )
      continue;
    allSourceFiles.push(path.join(CONFIG.srcDir, file));
  }

  if (allSourceFiles.length === 0) {
    throw new Error("Nenhum arquivo TypeScript encontrado");
  }

  const proc = Bun.spawn({
    cmd: [
      "bun",
      "tsc",
      "--declaration",
      "--emitDeclarationOnly",
      "--outDir",
      CONFIG.distDir,
      "--rootDir",
      CONFIG.srcDir,
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--target",
      "ESNext",
      "--strict",
      "--esModuleInterop",
      "--skipLibCheck",
      ...allSourceFiles,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error("Falha ao gerar declarações de tipo");
  }

  for (const target of targets) {
    const baseName = path.basename(CONFIG.entryFile, ".ts");
    const originalDts = path.join(target.outDir, `${baseName}.d.ts`);
    const finalDts = path.join(target.outDir, "index.d.ts");

    try {
      await rename(originalDts, finalDts);
    } catch (e) {
      // ignora se já for index.d.ts
    }
  }

  console.log("✅ Declarações geradas");
}

async function generatePackageJson(
  targets: BuildTarget[],
  hasReadme: boolean,
  rootPkg: RootPackageJson | null,
) {
  console.log("\n📋 Gerando package.json do dist...");

  const exports: Record<string, any> = {};

  for (const target of targets) {
    const pathPrefix = target.relDir === "." ? "" : `${target.relDir}/`;
    exports[target.exportKey] = {
      types: `./${pathPrefix}index.d.ts`,
      import: `./${pathPrefix}index.js`,
      default: `./${pathPrefix}index.js`,
    };
  }

  const hasRootExport = targets.some((t) => t.exportKey === ".");

  // Coleta dependências do package.json raiz se configurado
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};

  if (rootPkg) {
    if (CONFIG.includeDependencies && rootPkg.dependencies) {
      for (const [name, version] of Object.entries(rootPkg.dependencies)) {
        if (!CONFIG.bundledDependencies.includes(name)) {
          deps[name] = version;
        }
      }
    }
    if (CONFIG.includeDevDependencies && rootPkg.devDependencies) {
      Object.assign(devDeps, rootPkg.devDependencies);
    }
  }

  const pkg: any = {
    name: CONFIG.name,
    version: CONFIG.version,
    description: CONFIG.description,
    type: "module",
    main: hasRootExport ? "./index.js" : undefined,
    types: hasRootExport ? "./index.d.ts" : undefined,
    exports,
    files: ["**/*.js", "**/*.d.ts", "README.md", "LICENSE"],
    keywords: CONFIG.keywords,
    author: CONFIG.author,
    license: CONFIG.license,
    repository: CONFIG.repository,

    // Adiciona referência ao README
    ...(hasReadme && { readme: "./README.md" }),

    // Adiciona outras URLs se existirem no package.json raiz
    ...(rootPkg?.bugs && { bugs: rootPkg.bugs }),
    ...(rootPkg?.homepage && { homepage: rootPkg.homepage }),
    ...(rootPkg?.engines && { engines: rootPkg.engines }),

    // Dependências (somente se houver)
    ...(Object.keys(deps).length > 0 && { dependencies: deps }),
    ...(Object.keys(devDeps).length > 0 && { devDependencies: devDeps }),

    // Peer dependencies se existirem no original
    ...(rootPkg?.peerDependencies && {
      peerDependencies: rootPkg.peerDependencies,
    }),
    ...(rootPkg?.peerDependenciesMeta && {
      peerDependenciesMeta: rootPkg.peerDependenciesMeta,
    }),
  };

  // Remove campos undefined
  Object.keys(pkg).forEach((key) => {
    if (pkg[key] === undefined) delete pkg[key];
  });

  await Bun.write(
    path.join(CONFIG.distDir, "package.json"),
    JSON.stringify(pkg, null, 2),
  );

  console.log("   ✅ package.json gerado");
  if (Object.keys(deps).length > 0) {
    console.log(`   📦 Dependencies: ${Object.keys(deps).length} pacote(s)`);
  }
  if (Object.keys(devDeps).length > 0) {
    console.log(
      `   🔧 DevDependencies: ${Object.keys(devDeps).length} pacote(s)`,
    );
  }
  if (hasReadme) {
    console.log(`   📄 Readme: referenciado`);
  }
}

async function generateJsrJson(
  targets: BuildTarget[],
  rootPkg: RootPackageJson | null,
) {
  console.log("\n📋 Gerando jsr.json do dist...");

  const exports: Record<string, string> = {};

  for (const target of targets) {
    const pathPrefix = target.relDir === "." ? "" : `${target.relDir}/`;
    exports[target.exportKey] = `./${pathPrefix}index.js`;
  }

  const jsr: any = {
    name: CONFIG.name,
    version: CONFIG.version,
    exports,
  };

  await Bun.write(
    path.join(CONFIG.distDir, "jsr.json"),
    JSON.stringify(jsr, null, 2),
  );

  console.log("   ✅ jsr.json gerado");
}

async function main() {
  try {
    // Lê package.json raiz logo no início
    const rootPkg = await getRootPackageJson();
    if (rootPkg) {
      console.log(`   📦 Package.json raiz detectado`);
      if (rootPkg.version) CONFIG.version = rootPkg.version;
      if (rootPkg.description) CONFIG.description = rootPkg.description;
      if (rootPkg.author)
        CONFIG.author =
          typeof rootPkg.author === "string"
            ? rootPkg.author
            : rootPkg.author.name;
    }

    console.log(`🚀 Build iniciado para: ${CONFIG.name}@${CONFIG.version}`);

    await clean();
    const hasReadme = await copyMetadataFiles();
    const targets = await getEntrypoints();

    await buildJS(targets, rootPkg);
    await buildDeclarations(targets);
    await generatePackageJson(targets, hasReadme, rootPkg);
    await generateJsrJson(targets, rootPkg);

    console.log(`\n✅ Build completado!`);
    console.log(`\n📁 Conteúdo do ${CONFIG.distDir}:`);

    // Lista o que foi gerado
    const listGlob = new Bun.Glob("**/*");
    const files: string[] = [];
    for await (const file of listGlob.scan({ cwd: CONFIG.distDir })) {
      files.push(file);
    }
    files.sort().forEach((f) => console.log(`   ${f}`));

    console.log(`\n💡 Para publicar:`);
    console.log(`   cd ${CONFIG.distDir}`);
    console.log(`   npm publish --access public`);
  } catch (error) {
    console.error("\n❌ Erro no build:", error);
    process.exit(1);
  }
}

main();
