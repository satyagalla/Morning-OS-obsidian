import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { MorningView, VIEW_TYPE_MORNING, AreaView, DumpView, TrashView, VIEW_TYPE_AREA, VIEW_TYPE_DUMP, VIEW_TYPE_TRASH } from "./view";
import { MorningOSSettings, DEFAULT_SETTINGS, MorningOSSettingTab } from "./settings";
import { runAgent, refreshBrief, AgentResult } from "./agent/run";
import { scaffoldDailyNote } from "./agent/scaffold-daily-note";
import { loadRegistry, saveRegistry, createTask, recoverRegistryAreas } from "./task-registry";
import { parseBulletFile, parseDailyNote, parseSectionFromFile, appendWinToLog } from "./agent/vault-reader";
import { todayStr } from "./utils";

// Undocumented internal API surface used to coordinate with the remotely-save
// community plugin (if installed) so large archive batches don't race its sync.
interface RemotelySavePlugin {
  settings?: { concurrency?: number };
  isSyncing?: boolean;
  syncRun?: () => void;
}
interface InternalPluginsHost {
  plugins?: { plugins?: Record<string, RemotelySavePlugin> };
}

export default class MorningOSPlugin extends Plugin {
  settings: MorningOSSettings;
  settingTab: MorningOSSettingTab;
  private agentRunning = false;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as MorningOSSettings;

    // Migrate feedToLLM onto existing area configs that predate the field
    for (const area of this.settings.areas) {
      if (area.feedToLLM === undefined) {
        area.feedToLLM = !["family", "relationship"].includes(area.key);
      }
    }

    // Migrate llmSectionMappings if missing
    if (!this.settings.llmSectionMappings?.length) {
      this.settings.llmSectionMappings = DEFAULT_SETTINGS.llmSectionMappings;
    }

    // Migrate sourceWins if missing
    if (!this.settings.sourceWins) {
      this.settings.sourceWins = DEFAULT_SETTINGS.sourceWins;
    }

    if (!this.settings.onboarded && this.settings.agentLastRunDate) {
      this.settings.onboarded = true;
      await this.saveData(this.settings);
    }

    // Must run before any view or agent can load and re-save the registry.
    const areasRecovery = await recoverRegistryAreas(this.app, this.settings.areas);
    if (areasRecovery.settingsChanged) {
      await this.saveData(this.settings);
    }
    if (areasRecovery.error) {
      console.error("Morning OS area recovery failed:", areasRecovery.error);
      new Notice(`Morning OS: area recovery failed — ${areasRecovery.error}`);
    } else if (areasRecovery.changed || areasRecovery.settingsChanged) {
      const details = [
        `${areasRecovery.tasksRecovered} task${areasRecovery.tasksRecovered === 1 ? "" : "s"} recovered`,
        `${areasRecovery.areasCreated} area${areasRecovery.areasCreated === 1 ? "" : "s"} created`,
        `${areasRecovery.tabsCreated} tab${areasRecovery.tabsCreated === 1 ? "" : "s"} created`,
      ];
      if (areasRecovery.backupCreated) details.push("backup saved");
      new Notice(`Morning OS: area recovery complete — ${details.join(", ")}.`, 8000);
    }

    this.registerView(VIEW_TYPE_MORNING, (leaf) => new MorningView(leaf, this.settings, this));
    this.registerView(VIEW_TYPE_DUMP, (leaf) => new DumpView(leaf, this.settings, this));
    this.registerView(VIEW_TYPE_TRASH, (leaf) => new TrashView(leaf, this.settings, this));
    for (const area of this.settings.areas) {
      const key = area.key;
      this.registerView(`${VIEW_TYPE_AREA}-${key}`, (leaf) => new AreaView(leaf, this.settings, this, key));
    }

    this.addRibbonIcon("sun", "Morning OS", () => {
      void this.activateView();
    });

    this.settingTab = new MorningOSSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_MORNING);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_MORNING, active: true });
    }

    await workspace.revealLeaf(leaf);
  }

  async triggerAgent(): Promise<void> {
    if (this.agentRunning) {
      new Notice("Morning OS: agent is already running.");
      return;
    }

    this.agentRunning = true;
    new Notice("Morning OS: running briefing agent…");

    try {
      const result: AgentResult = await runAgent(this.app, this.settings);
      this.settings.agentLastRunDate = todayStr();
      this.settings.settingsChangedSinceRun = false;
      await this.saveData(this.settings);
      if (result.mode === "direct-no-keys") {
        new Notice("Morning OS: brief ready (direct mode — no API key configured)");
      } else {
        new Notice("Morning OS: brief ready ✓");
      }
      this.settingTab.clearDirty();
      await this.refreshView();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith("LLM_FAILED:")) {
        const detail = msg.replace("LLM_FAILED: ", "");
        new Notice(`Morning OS: LLM error — ${detail}\n\nCheck your API key in settings, or turn off Use AI for briefings.`, 10000);
      } else {
        new Notice(`Morning OS: agent failed — ${msg.slice(0, 120)}`);
      }
      console.error("Morning OS agent error:", err);
    } finally {
      this.agentRunning = false;
    }
  }

  async triggerRefresh(): Promise<void> {
    const today = todayStr();

    await scaffoldDailyNote(today, this.app, this.settings);

    const briefPath = `${this.settings.briefsDir}/${today}.json`;
    const briefExists = await this.app.vault.adapter.exists(briefPath);
    if (!briefExists) {
      await this.triggerAgent();
      return;
    }

    try {
      await refreshBrief(this.app, this.settings);
      new Notice("Morning OS: brief refreshed ✓");
      await this.refreshView();
    } catch (err) {
      new Notice(`Morning OS: ${(err as Error).message}`);
    }
  }

  async refreshView(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MORNING)) {
      await leaf.loadIfDeferred();
      if (leaf.view instanceof MorningView) await leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DUMP)) {
      await leaf.loadIfDeferred();
      if (leaf.view instanceof DumpView) await leaf.view.refresh();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TRASH)) {
      await leaf.loadIfDeferred();
      if (leaf.view instanceof TrashView) await leaf.view.refresh();
    }
    for (const area of this.settings.areas) {
      for (const leaf of this.app.workspace.getLeavesOfType(`${VIEW_TYPE_AREA}-${area.key}`)) {
        await leaf.loadIfDeferred();
        if (leaf.view instanceof AreaView) await leaf.view.refresh();
      }
    }
  }

  async reregisterAreaViews() {
    for (const area of this.settings.areas) {
      this.app.workspace.getLeavesOfType(`${VIEW_TYPE_AREA}-${area.key}`)
        .forEach(l => l.detach());
    }
    for (const area of this.settings.areas) {
      const key = area.key;
      this.registerView(`${VIEW_TYPE_AREA}-${key}`, (leaf) => new AreaView(leaf, this.settings, this, key));
    }
    await this.refreshView();
  }

  async activateDump() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_DUMP);
    const leaf = leaves.length > 0 ? leaves[0] : workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_DUMP, active: true });
    await workspace.revealLeaf(leaf);
  }

  async activateTrash() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_TRASH);
    const leaf = leaves.length > 0 ? leaves[0] : workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_TRASH, active: true });
    await workspace.revealLeaf(leaf);
  }

  async activateArea(key: string) {
    const type = `${VIEW_TYPE_AREA}-${key}`;
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(type);
    const leaf = leaves.length > 0 ? leaves[0] : workspace.getLeaf("tab");
    await leaf.setViewState({ type, active: true });
    await workspace.revealLeaf(leaf);
  }

  async autoRefreshBrief(): Promise<void> {
    const briefPath = `${this.settings.briefsDir}/${todayStr()}.json`;
    if (!(await this.app.vault.adapter.exists(briefPath))) {
      void this.triggerAgent();
      return;
    }
    try { await refreshBrief(this.app, this.settings); } catch { /* non-critical */ }
  }

  async migrateVault(): Promise<void> {
    const today = todayStr();
    const userFolder = this.settings.dailyNoteDir.split("/")[0] || "Essential";
    const results: string[] = [];
    const archiveDir = "_archive/pre-migration";

    // Ensure Areas directory exists
    const areasDir = `${userFolder}/Areas`;
    if (!(await this.app.vault.adapter.exists(areasDir))) {
      await this.app.vault.adapter.mkdir(areasDir);
    }

    // On an explicit re-run, use a previously archived source when its legacy
    // location no longer exists. This keeps migration recovery non-destructive.
    const resolveMigrationSource = async (sourcePath: string, archiveName: string) => {
      if (await this.app.vault.adapter.exists(sourcePath)) return sourcePath;
      const archivedPath = `${archiveDir}/${archiveName}`;
      return (await this.app.vault.adapter.exists(archivedPath)) ? archivedPath : null;
    };

    // Area keys are stable identifiers; labels are user-editable filenames.
    const areaLabelForKey = (key: string) =>
      this.settings.areas.find(area => area.key === key)?.label ?? null;
    const healthAreaLabel = areaLabelForKey("health");
    const careerAreaLabel = areaLabelForKey("career");

    // Helper: append missing bullets to a section in an area markdown (idempotent per bullet)
    const appendSectionToArea = async (areaLabel: string, sectionHeading: string, bullets: string[]) => {
      if (bullets.length === 0) return;
      const path = `${areasDir}/${areaLabel}.md`;
      let content = (await this.app.vault.adapter.exists(path))
        ? await this.app.vault.adapter.read(path)
        : "";

      // Read existing bullets in this section to avoid duplicates
      const existingInSection = new Set(
        content.split("\n")
          .filter(l => l.trim().startsWith("- "))
          .map(l => l.trim().replace(/^-\s+/, "").toLowerCase())
      );

      const missing = bullets.filter(b => !existingInSection.has(b.toLowerCase().trim()));
      if (missing.length === 0) return;

      const headingLine = `## ${sectionHeading}`;
      if (content.includes(headingLine)) {
        // Append missing bullets before next heading or at end
        const lines = content.split("\n");
        const headingIdx = lines.findIndex(l => l.trim() === headingLine);
        let insertIdx = headingIdx + 1;
        while (insertIdx < lines.length && !lines[insertIdx].startsWith("## ")) insertIdx++;
        lines.splice(insertIdx, 0, ...missing.map(b => `- ${b}`));
        content = lines.join("\n");
      } else {
        content = content.trimEnd() + (content ? "\n\n" : "") + `${headingLine}\n${missing.map(b => `- ${b}`).join("\n")}\n`;
      }

      await this.app.vault.adapter.write(path, content);
    };

    // 0. Create area markdown files for all areas (idempotent — skip if already exists)
    let areasCreated = 0;
    for (const area of this.settings.areas) {
      const path = `${areasDir}/${area.label}.md`;
      if (!(await this.app.vault.adapter.exists(path))) {
        await this.app.vault.adapter.write(path, "");
        areasCreated++;
      }
    }
    if (areasCreated > 0) results.push(`✓ Created ${areasCreated} area markdown files`);

    // 1. Migrate Tactical Rules → Health.md ## Tactical Rules
    const tacticalSource = await resolveMigrationSource(this.settings.sourceTacticalRules, "Tactical Rules.md");
    const tactical = tacticalSource ? await parseBulletFile(tacticalSource, this.app) : [];
    const tacticalMigrated = tactical.length > 0 && healthAreaLabel !== null;
    if (tacticalMigrated) {
      await appendSectionToArea(healthAreaLabel, "Tactical Rules", tactical);
      results.push(`✓ ${tactical.length} tactical rules → Health area`);
    }

    // 2. Migrate Emotional Rules → Health.md ## Emotional Rules
    const emotionalSource = await resolveMigrationSource(this.settings.sourceEmotionalRules, "Emotional Rules.md");
    const emotional = emotionalSource ? await parseBulletFile(emotionalSource, this.app) : [];
    const emotionalMigrated = emotional.length > 0 && healthAreaLabel !== null;
    if (emotionalMigrated) {
      await appendSectionToArea(healthAreaLabel, "Emotional Rules", emotional);
      results.push(`✓ ${emotional.length} emotional rules → Health area`);
    }

    // 3. Migrate Goals → Career.md ## Short Term / ## Long Term
    const goalsSource = await resolveMigrationSource(this.settings.sourceGoals, "Goals.md");
    const goalContent = goalsSource
      ? await this.app.vault.adapter.read(goalsSource)
      : "";
    let goalsMigrated = false;
    if (goalContent) {
      const shortGoals = await parseSectionFromFile(goalsSource!, this.settings.goalsShortTerm, this.app);
      const longGoals  = await parseSectionFromFile(goalsSource!, this.settings.goalsLongTerm, this.app);
      if ((shortGoals.length || longGoals.length) && careerAreaLabel) {
        if (shortGoals.length) await appendSectionToArea(careerAreaLabel, "Short Term", shortGoals);
        if (longGoals.length) await appendSectionToArea(careerAreaLabel, "Long Term", longGoals);
        goalsMigrated = true;
        results.push(`✓ Goals (${shortGoals.length} short, ${longGoals.length} long) → Career area`);
      }
    }

    // 4. Migrate Technical Tasks → registry with career area
    const registry = await loadRegistry(this.app);
    const existingTexts = new Set(registry.map(t => t.text.toLowerCase().trim()));
    let tasksAdded = 0;
    const add = (text: string, opts: Parameters<typeof createTask>[1] = {}) => {
      const clean = text.trim();
      if (!clean || existingTexts.has(clean.toLowerCase())) return;
      existingTexts.add(clean.toLowerCase());
      registry.push(createTask(clean, opts));
      tasksAdded++;
    };

    const technicalSource = await resolveMigrationSource(this.settings.sourceTechnicalTasks, "Technical Tasks.md");
    const technical = technicalSource ? await parseBulletFile(technicalSource, this.app) : [];
    for (const t of technical) add(t, { areas: ["career"] });
    if (technical.length) results.push(`✓ ${technical.length} technical tasks → Career registry`);

    // 5. Migrate Hobby Tasks → registry with interests area
    const hobbySource = await resolveMigrationSource(this.settings.sourceHobbyTasks, "Hobby Tasks.md");
    const hobby = hobbySource ? await parseBulletFile(hobbySource, this.app) : [];
    for (const t of hobby) add(t, { areas: ["interests"] });
    if (hobby.length) results.push(`✓ ${hobby.length} hobby tasks → Interests registry`);

    // 6. Migrate today's daily note tasks → registry (undone only, no area)
    const dailyData = await parseDailyNote(today, this.app, this.settings);
    if (dailyData) {
      for (const t of dailyData.red_alert.filter(t => !t.done))
        add(t.text, { status_priority: "red", is_today: true });
      for (const t of dailyData.regular.filter(t => !t.done))
        add(t.text, { status_priority: "regular", is_today: true });
      const taskCount = dailyData.red_alert.filter(t => !t.done).length + dailyData.regular.filter(t => !t.done).length;
      if (taskCount) results.push(`✓ ${taskCount} daily note tasks → registry (Today)`);
    }

    if (tasksAdded > 0) await saveRegistry(this.app, registry);

    // 7. Migrate ALL wins from all daily notes → Essential/Wins.md
    const winsPath = this.settings.sourceWins;
    if (!(await this.app.vault.adapter.exists(winsPath))) {
      await this.app.vault.adapter.write(winsPath, "");
    }
    let totalWins = 0;
    const dailyDirPath = this.settings.dailyNoteDir;
    if (await this.app.vault.adapter.exists(dailyDirPath)) {
      const dailyListing = await this.app.vault.adapter.list(dailyDirPath);
      const sortedFiles = dailyListing.files
        .filter(f => /\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort(); // oldest first — appendWinToLog prepends date headings so newest ends up on top
      for (const filePath of sortedFiles) {
        const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})\.md$/);
        if (!dateMatch) continue;
        const fileDate = dateMatch[1];
        const parsed = await parseDailyNote(fileDate, this.app, this.settings);
        if (!parsed) continue;
        for (const win of parsed.wins) {
          await appendWinToLog(win.text, fileDate, this.app, this.settings);
          totalWins++;
        }
      }
    }
    if (totalWins > 0) results.push(`✓ ${totalWins} historical wins → Wins.md`);
    else results.push(`✓ Created Wins.md`);

    // 8. Archive old source files (only if content was migrated)
    const filesToArchive: { src: string; dest: string; migrated: boolean }[] = [
      { src: this.settings.sourceTacticalRules, dest: `${archiveDir}/Tactical Rules.md`, migrated: tacticalMigrated },
      { src: this.settings.sourceEmotionalRules, dest: `${archiveDir}/Emotional Rules.md`, migrated: emotionalMigrated },
      { src: this.settings.sourceGoals, dest: `${archiveDir}/Goals.md`, migrated: goalsMigrated },
      { src: this.settings.sourceTechnicalTasks, dest: `${archiveDir}/Technical Tasks.md`, migrated: technical.length > 0 },
      { src: this.settings.sourceHobbyTasks, dest: `${archiveDir}/Hobby Tasks.md`, migrated: hobby.length > 0 },
    ];

    let archived = 0;
    for (const entry of filesToArchive) {
      if (!entry.migrated) continue;
      if (!(await this.app.vault.adapter.exists(entry.src))) continue;
      if (!(await this.app.vault.adapter.exists(archiveDir))) {
        await this.app.vault.adapter.mkdir(archiveDir);
      }
      // Copy if not already archived
      if (!(await this.app.vault.adapter.exists(entry.dest))) {
        const content = await this.app.vault.adapter.read(entry.src);
        await this.app.vault.adapter.write(entry.dest, content);
      }
      // Always delete source via adapter to avoid stale cache
      await this.app.vault.adapter.remove(entry.src);
      archived++;
    }
    if (archived > 0) results.push(`✓ ${archived} old files archived to _archive/pre-migration/`);

    // 9. Archive daily notes in sync-safe batches
    const dailyDir = this.settings.dailyNoteDir;
    if (await this.app.vault.adapter.exists(dailyDir)) {
      const dailyArchiveDir = "_archive/daily-notes";
      if (!(await this.app.vault.adapter.exists("_archive"))) {
        await this.app.vault.adapter.mkdir("_archive");
      }
      if (!(await this.app.vault.adapter.exists(dailyArchiveDir))) {
        await this.app.vault.adapter.mkdir(dailyArchiveDir);
      }

      // Read remotely-save concurrency setting — fall back to 5 if not installed
      const remotelySave = (this.app as unknown as InternalPluginsHost).plugins?.plugins?.["remotely-save"];
      const concurrency: number = remotelySave?.settings?.concurrency ?? 5;
      const batchSize = Math.max(1, concurrency - 1);

      const waitForSyncIdle = async () => {
        if (!remotelySave) return;
        // Give remotely-save a moment to pick up the changes
        await new Promise(r => window.setTimeout(r, 500));
        // Poll until isSyncing is false
        while (remotelySave.isSyncing) {
          await new Promise(r => window.setTimeout(r, 500));
        }
      };

      const listing = await this.app.vault.adapter.list(dailyDir);
      // Archive all files in the daily folder; delete empty ones outright
      const dailyFiles = listing.files;
      let archivedNotes = 0;

      for (let i = 0; i < dailyFiles.length; i += batchSize) {
        const batch = dailyFiles.slice(i, i + batchSize);

        for (const filePath of batch) {
          const fileName = filePath.split("/").pop() ?? filePath;
          const destPath = `${dailyArchiveDir}/${fileName}`;
          const content = await this.app.vault.adapter.read(filePath);
          if (content.trim().length === 0) {
            // Empty file — just delete, no value in archiving
            await this.app.vault.adapter.remove(filePath);
          } else {
            // Copy if not already in archive, then delete source
            if (!(await this.app.vault.adapter.exists(destPath))) {
              await this.app.vault.adapter.write(destPath, content);
            }
            await this.app.vault.adapter.remove(filePath);
          }
          archivedNotes++;
        }

        // Trigger sync and wait for idle before next batch
        if (remotelySave && i + batchSize < dailyFiles.length) {
          if (!remotelySave.isSyncing) remotelySave.syncRun?.();
          await waitForSyncIdle();
        }

        new Notice(`Morning OS: archiving daily notes... (${Math.min(i + batchSize, dailyFiles.length)}/${dailyFiles.length})`, 2000);
      }

      // Clean up daily folder if now empty
      if (await this.app.vault.adapter.exists(dailyDir)) {
        const remaining = await this.app.vault.adapter.list(dailyDir);
        if (remaining.files.length === 0) {
          const dailyFolder = this.app.vault.getAbstractFileByPath(dailyDir);
          if (dailyFolder) await this.app.fileManager.trashFile(dailyFolder);
        }
      }

      // Final sync after all batches
      if (remotelySave) {
        if (!remotelySave.isSyncing) remotelySave.syncRun?.();
        await waitForSyncIdle();
      }

      results.push(`✓ ${archivedNotes} daily notes archived to _archive/daily-notes/ (concurrency: ${concurrency})`);
    }

    // Delete now-empty legacy folders
    const foldersToDelete = [
      `${userFolder}/State of Mind`,
      `${userFolder}/Pending Tasks`,
    ];
    for (const folderPath of foldersToDelete) {
      if (!(await this.app.vault.adapter.exists(folderPath))) continue;
      const listing = await this.app.vault.adapter.list(folderPath);
      if (listing.files.length === 0 && listing.folders.length === 0) {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (folder) await this.app.fileManager.trashFile(folder);
        results.push(`✓ Deleted empty folder: ${folderPath}`);
      }
    }

    this.settings.migrationComplete = true;
    await this.saveData(this.settings);
    this.refreshView();

    if (results.length === 0) {
      new Notice("Morning OS: All content already migrated — nothing new to move.");
    } else {
      new Notice(`Morning OS migration complete:\n${results.join("\n")}`, 8000);
    }
  }

  // Legacy alias kept for any command palette registrations
  async migrateExistingTasks(): Promise<void> {
    await this.migrateVault();
  }

  onunload() { /* intentional — no teardown needed beyond Obsidian's built-in deregister */ }
}
