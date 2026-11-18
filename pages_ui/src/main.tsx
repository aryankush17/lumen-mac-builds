import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultStyleSpecs,
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu as insertOrUpdateBlock,
} from "@blocknote/core";
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
  createReactStyleSpec,
  FormattingToolbarController, FormattingToolbar, BlockTypeSelect,
  BasicTextStyleButton, ColorStyleButton, CreateLinkButton, useComponentsContext, useBlockNoteEditor, usePortalElement,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import {
  Search,
  Plus,
  ChevronRight,
  Star,
  Trash2,
  PanelLeftClose,
  PanelLeft,
  MoreHorizontal,
  FileText,
  LayoutGrid,
  ArrowLeft,
  Download,
  Copy,
  FolderInput,
  X,
} from "lucide-react";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "./style.css";
import "./appearance.css";
import "./open-fonts.css";
import { openFonts } from "./openFonts";
import { Grid } from "./Grid";
import {PageHistory, SavedVersion} from "./PageHistory";
import { RecordPageNavigation } from "./WorkspaceNavigation";
import { PageAppearance, coverStyle } from "./PageAppearance";
import { DocumentGuide, jumpToBlock, workspaceTemplates, TemplateLibrary, ActionRadar, Guidance } from './WorkspaceTools';

type Summary = {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string;
  cover: string;
  favorite: boolean;
  trashed: boolean;
  revision: number;
  updated: string;
};
type Page = Summary & { document: any[] };
const fonts: Record<string, string> = {
  ...Object.fromEntries(openFonts.map(f => [f.id, `"${f.family}", ${f.fallback}`])),
  sans: "Inter, system-ui, sans-serif",
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Cascadia Code", Consolas, monospace',
};
const fontStyle = createReactStyleSpec(
  { type: "fontFamily", propSchema: "string" },
  {
    render: ({ value, contentRef }) => (
      <span
        style={{ fontFamily: fonts[value] || fonts.sans }}
        ref={contentRef}
      />
    ),
  },
);
const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, grid: Grid(), guidance: Guidance() },
  styleSpecs: { ...defaultStyleSpecs, fontFamily: fontStyle },
});
const token =
  document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ||
  "";
const workspaceHost = document.getElementById("lumen-workspace")!;
const integrated = workspaceHost.dataset.integrated === "true";
async function api(path: string, method = "GET", data?: unknown) {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(
      result.error || `Request failed (${response.status})`,
    );
    Object.assign(error, { status: response.status });
    throw error;
  }
  return result;
}
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const starter = [
  {
    type: "heading",
    props: { level: 2 },
    content: "A place to think, plan, and build.",
  },
  {
    type: "paragraph",
    content:
      "Write freely. Type / on a new line to add headings, checklists, tables, and collections. Drag the handle beside a block to move it.",
  },
  { type: "checkListItem", content: "Capture your first idea" },
  { type: "checkListItem", content: "Create a page for your next project" },
  { type: "paragraph", content: "" },
];

function highlightText(content: any[], color: string): any[] {
  return content.map((part) =>
    typeof part === "string"
      ? { type: "text", text: part, styles: { backgroundColor: color } }
      : part.type === "text"
        ? { ...part, styles: { ...part.styles, backgroundColor: color } }
        : Array.isArray(part.content)
          ? { ...part, content: highlightText(part.content, color) }
          : part,
  );
}
function migrateHighlights(blocks: any[]): any[] {
  return blocks.map((block) => {
    const next = { ...block };
    const color = block.props?.backgroundColor;
    if (color && color !== "default" && Array.isArray(block.content)) {
      next.props = { ...block.props, backgroundColor: "default" };
      next.content = highlightText(block.content, color);
    }
    if (block.children) next.children = migrateHighlights(block.children);
    return next;
  });
}

function SelectionToolbar() {
  const editor=useBlockNoteEditor();
  const Components=useComponentsContext()!;
  const portalElement=usePortalElement();
  const [font,setFont]=useState(String((editor.getActiveStyles() as Record<string,any>).fontFamily||'sans'));
  useEffect(()=>editor.onSelectionChange(()=>setFont(String((editor.getActiveStyles() as Record<string,any>).fontFamily||'sans'))),[editor]);
  const choices=[{id:'sans',family:'Sans serif'},{id:'serif',family:'Serif'},{id:'mono',family:'Monospace'},...openFonts];
  return <FormattingToolbar><BlockTypeSelect/>
    <Components.FormattingToolbar.Select portalElement={portalElement} className="bn-select workspace-font-select" items={choices.map(f=>({text:f.family,icon:<span style={{fontFamily:fonts[f.id]}}>Aa</span>,isSelected:font===f.id,onClick:()=>{editor.focus();editor.addStyles({fontFamily:f.id} as any);setFont(f.id);}}))}/>
    <BasicTextStyleButton basicTextStyle="bold"/><BasicTextStyleButton basicTextStyle="italic"/><BasicTextStyleButton basicTextStyle="underline"/>
    <ColorStyleButton/><CreateLinkButton/>
  </FormattingToolbar>;
}

function Editor({
  page,
  onChange,
  childPage,
  theme,
}: {
  page: Page;
  onChange: (blocks: any[]) => void;
  childPage: () => void;
  theme: "light" | "dark";
}) {
  const editor = useCreateBlockNote({
    schema,
    initialContent: page.document.length
      ? migrateHighlights(page.document)
      : undefined,
    tables: {
      splitCells: true,
      cellBackgroundColor: true,
      cellTextColor: true,
      headers: true,
    },
  });
  const normalizing = useRef(false);
  const [guideBlocks, setGuideBlocks] = useState<any[]>(editor.document);
  const changed = () => {
    if (normalizing.current) return;
    normalizing.current = true;
    try {
      const normalize = (blocks: any[]) =>
        blocks.forEach((block) => {
          const color = block.props?.backgroundColor;
          if (color && color !== "default" && Array.isArray(block.content)) {
            editor.updateBlock(block.id, {
              props: { backgroundColor: "default" },
              content: highlightText(block.content, color),
            });
            if (editor.getTextCursorPosition().block.id === block.id)
              editor.addStyles({ backgroundColor: color });
          }
          if (block.children) normalize(block.children);
        });
      normalize(editor.document);
      setGuideBlocks(editor.document);
      onChange(editor.document);
    } finally {
      normalizing.current = false;
    }
  };
  return (
    <>
      <DocumentGuide blocks={guideBlocks}/>
      {guideBlocks.length === 1 && guideBlocks[0].type === "paragraph" &&
        !guideBlocks[0].content?.length && !guideBlocks[0].children?.length && (
        <div className="page-starters" aria-label="Start your page">
          <span>Start with</span>
          <button onClick={() => { editor.focus(); insertOrUpdateBlock(editor, {type: "heading"}); }}>Heading</button>
          <button onClick={() => { editor.focus(); insertOrUpdateBlock(editor, {type: "checkListItem"}); }}>Checklist</button>
          <button onClick={() => { editor.focus(); insertOrUpdateBlock(editor, {type: "grid"}); }}>Collection</button>
        </div>
      )}
      <BlockNoteView
        editor={editor}
        theme={theme}
        slashMenu={false}
        formattingToolbar={false}
        onChange={changed}
      >
        <FormattingToolbarController formattingToolbar={SelectionToolbar}/>
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor).filter(
                  (item) =>
                    !["image", "video", "audio", "file"].includes(
                      item.title.toLowerCase(),
                    ),
                ),
                {
                  title: "Guidance",
                  subtext: "A subtle theme-coloured callout",
                  group: "Lumen",
                  aliases: ["callout", "note", "guidance"],
                  icon: <FileText size={18}/>,
                  onItemClick: () => insertOrUpdateBlock(editor, {type: "guidance"}),
                },
                {
                  title: "Collection",
                  subtext: "Table, gallery, board and calendar views",
                  group: "Lumen",
                  aliases: ["grid", "database", "cards"],
                  icon: <LayoutGrid size={18} />,
                  onItemClick: () =>
                    insertOrUpdateBlock(editor, { type: "grid" }),
                },
                {
                  title: "Subpage",
                  subtext: "Create a page inside this page",
                  group: "Lumen",
                  aliases: ["page", "child"],
                  icon: <FileText size={18} />,
                  onItemClick: childPage,
                },
              ],
              query,
            )
          }
        />
      </BlockNoteView>
    </>
  );
}

function App() {
  const [pages, setPages] = useState<Summary[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const current = useRef<Page | null>(null);
  const [locationReady, setLocationReady] = useState(false);
  const [area, setArea] = useState("home");
  const [dragPage, setDragPage] = useState<string | null>(null);
  const [dropPage, setDropPage] = useState<string | null>(null);
  const [moveNotice, setMoveNotice] = useState("");
  const movingPage = useRef(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [radar, setRadar] = useState(false);
  useLayoutEffect(()=>{document.getElementById('content')?.scrollTo({top:0});},[area,templates,radar]);
  const [jumpTarget,setJumpTarget]=useState<string|null>(null);
  useEffect(()=>{if(!jumpTarget||templates||radar||area!=="page")return;const frame=requestAnimationFrame(()=>{jumpToBlock(jumpTarget);setJumpTarget(null);});return ()=>cancelAnimationFrame(frame);},[jumpTarget,templates,radar,area,page]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [taskCount, setTaskCount] = useState(0);
  const [radarError, setRadarError] = useState('');
  const [radarBusy, setRadarBusy] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  useEffect(() => {
    if (!search) return;
    let cancelled = false;
    setSearchBusy(true); setSearchError('');
    const timer = setTimeout(() => {
      api('/api/pages-insights?q='+encodeURIComponent(query)).then(data=>{if(!cancelled)setSearchResults(data.pages);})
        .catch(e=>{if(!cancelled)setSearchError(e.message);})
        .finally(()=>{if(!cancelled)setSearchBusy(false);});
    },180);
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[search,query,pages]);
  useEffect(() => {
    if (!radar) return;
    let cancelled=false;setRadarBusy(true);setRadarError('');
    api('/api/pages-insights?mode=tasks').then(data=>{if(!cancelled){setTasks(data.tasks);setTaskCount(data.task_count);}})
      .catch(e=>{if(!cancelled)setRadarError(e.message);})
      .finally(()=>{if(!cancelled)setRadarBusy(false);});
    return ()=>{cancelled=true;};
  },[radar,pages]);
  const [history,setHistory]=useState<{id:string;versions:SavedVersion[]}|null>(null);
  const [menu, setMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editorSession, setEditorSession] = useState(0);
  const [side, setSide] = useState(() => !window.matchMedia('(max-width:580px)').matches);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width:580px)');
    const resize = () => { if (narrow.matches) setSide(false); };
    narrow.addEventListener('change', resize);
    return () => narrow.removeEventListener('change', resize);
  }, []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState("");
  const [legacy, setLegacy] = useState<{ id: string; title: string }[] | null>(
    null,
  );
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("lumen-pages-theme") === "dark" ? "dark" : "light",
  );
  const dirty = useRef(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pending = useRef<Promise<boolean> | null>(null);
  const blocked = useRef(false);
  const nav = useRef(0);
  const refresh = useCallback(async () => {
    const data = await api("/api/pages");
    setPages(data.pages);
    return data.pages as Summary[];
  }, []);
  const save = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current);
    if (pending.current) return pending.current;
    if (!dirty.current || !current.current) return Promise.resolve(true);
    if (blocked.current) return Promise.resolve(false);
    const operation = (async () => {
      try {
        while (dirty.current && current.current) {
          const snapshot = current.current;
          const version = generation.current;
          setStatus("Saving…");
          const result: Page = await api("/api/pages/" + snapshot.id, "PATCH", {
            revision: snapshot.revision,
            title: snapshot.title,
            icon: snapshot.icon,
            cover: snapshot.cover,
            document: snapshot.document,
          });
          if (current.current?.id === result.id) {
            current.current = {
              ...current.current,
              revision: result.revision,
              updated: result.updated,
            };
            dirty.current = generation.current !== version;
            setStatus(dirty.current ? "Unsaved changes" : "Saved");
            if (!dirty.current) {
              try {
                localStorage.removeItem("lumen-page-draft:" + result.id);
              } catch (_) {}
            }
          }
          await refresh();
        }
        return true;
      } catch (e) {
        setError(String((e as Error).message));
        setStatus("Not saved");
        blocked.current = (e as Error & { status?: number }).status === 409;
        return false;
      }
    })();
    pending.current = operation.finally(() => {
      pending.current = null;
    });
    return pending.current;
  }, [refresh]);
  const edit = (patch: Partial<Page>) => {
    if (!current.current) return;
    current.current = { ...current.current, ...patch };
    dirty.current = true;
    generation.current++;
    setStatus("Unsaved changes");
    try {
      localStorage.setItem(
        "lumen-page-draft:" + current.current.id,
        JSON.stringify(current.current),
      );
    } catch {
      /* Server saving remains authoritative if browser storage is full. */
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 650);
  };
  const open = async (id: string) => {
    const request = ++nav.current;
    setLoading(true);
    try {
      if (!(await save())) return;
      const next: Page = await api("/api/pages/" + id);
      if (request !== nav.current) return;
      if (next.trashed) {
        await refresh();
        throw new Error("This page is in the trash. Restore it first.");
      }
      current.current = next;
      setPage(next);
      setEditorSession((value) => value + 1);
      setStatus("Saved");
      setArea("page"); setTemplates(false); setRadar(false);
      if (window.matchMedia('(max-width:580px)').matches) setSide(false);
      setMenu(false);
      setSearch(false);
      setQuery("");
      setError("");
      blocked.current = false;
      localStorage.setItem("lumen-pages-last", id);
      if (localStorage.getItem("lumen-page-draft:" + id))
        setError(
          "An unsaved local draft is available. Download it before continuing if you need to recover those changes.",
        );
      return true;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (request === nav.current) setLoading(false);
    }
  };
  const go = async (next: string) => {
    if (await save()) {
      ++nav.current;
      setLoading(false);
      setArea(next); setTemplates(false); setRadar(false);
      setMenu(false);
    }
  };
  const creating = useRef(false);
  const create = async (parent_id: string | null = null, template = false) => {
    if (creating.current) return;
    creating.current = true;
    setLoading(true);
    try {
      if (!(await save())) return;
      const next = await api("/api/pages", "POST", {
        title: template ? "Welcome to your workspace" : "Untitled",
        parent_id,
        ...(template ? { document: starter } : {}),
      });
      await refresh();
      if (parent_id) setExpanded(new Set([...expanded, parent_id]));
      await open(next.id);
      requestAnimationFrame(() => {
        const title =
          workspaceHost.querySelector<HTMLTextAreaElement>(".page-title");
        title?.focus();
        title?.select();
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      creating.current = false;
      setLoading(false);
    }
  };
  const createFromTemplate = async (template: typeof workspaceTemplates[number]) => {
    if (creating.current) return;
    creating.current=true;setLoading(true);
    try {
      if (!(await save())) return;
      const next=await api('/api/pages','POST',{title:template.name,cover:template.cover,icon:template.icon,document:template.blocks.map(block=>({...block,id:crypto.randomUUID()}))});
      await refresh();await open(next.id);setTemplates(false);
    } catch(e){setError((e as Error).message);}
    finally{creating.current=false;setLoading(false);}
  };
  const mutate = async (patch: Partial<Page>) => {
    if (!(await save()) || !current.current) return;
    try {
      const next: Page = await api(
        "/api/pages/" + current.current.id,
        "PATCH",
        { ...patch, revision: current.current.revision },
      );
      current.current = next;
      setPage(next);
      await refresh();
      setMenu(false);
      if (next.trashed) {
        current.current = null;
        setPage(null);
        setArea("home");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    const restoreLocation = async () => {
      const available = await refresh();
      let saved;
      try { saved = JSON.parse(sessionStorage.getItem("lumen-workspace-location") || "null"); } catch {}
      if (saved?.area === "page" && available.some(p => p.id === saved.page && !p.trashed)) {
        await open(saved.page);
      } else if (saved?.area === "trash") {
        setArea("trash");
      }
      setTemplates(saved?.templates === true);
      setRadar(saved?.radar === true);
    };
    restoreLocation().catch(e => setError(e.message)).finally(() => setLocationReady(true));
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const key = (event: KeyboardEvent) => {
      if (integrated && document.body.dataset.view !== "sheets") return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearch((s) => !s);
      }
      if (event.key === "Escape") {
        setSearch(false);
        setMenu(false);
        setLegacy(null);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    const message = (event: MessageEvent) => {
      if (
        event.origin === location.origin &&
        event.data?.type === "lumen-pages-refresh"
      )
        void refresh();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("keydown", key);
    window.addEventListener("message", message);
    const appearance = () =>
      setTheme(
        document.documentElement.dataset.appearance === "dark"
          ? "dark"
          : "light",
      );
    if (integrated) appearance();
    window.addEventListener("lumen-appearance", appearance);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("keydown", key);
      window.removeEventListener("message", message);
      window.removeEventListener("lumen-appearance", appearance);
    };
  }, [refresh, save]);
  useEffect(() => {
    workspaceHost.dataset.theme = theme;
    localStorage.setItem("lumen-pages-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!locationReady) return;
    try {
      sessionStorage.setItem("lumen-workspace-location", JSON.stringify({
        area, page: page?.id, templates, radar,
      }));
    } catch {}
  }, [locationReady, area, page?.id, templates, radar]);
  const active = pages.filter((p) => !p.trashed);
  const matches = (p: Summary) =>
    (p.title || "Untitled").toLowerCase().includes(query.trim().toLowerCase());
  const libraryPages = pages.filter(p => Boolean(p.trashed) === (area === "trash") && matches(p));
  const roots = active.filter((p) => !p.parent_id);
  const childPages = active.filter((p) => p.parent_id === page?.id);
  const canDropPage = (parent: string | null) => {
    if (!dragPage || movingPage.current) return false;
    const source = active.find(p => p.id === dragPage);
    if (!source || source.parent_id === parent) return false;
    const seen = new Set<string>();
    let cursor = parent;
    while (cursor) {
      if (cursor === dragPage || seen.has(cursor)) return false;
      seen.add(cursor);
      cursor = active.find(p => p.id === cursor)?.parent_id || null;
    }
    return true;
  };
  const dropInto = async (parent: string | null) => {
    if (!canDropPage(parent)) return;
    const source = active.find(p => p.id === dragPage)!;
    movingPage.current = true;
    setDragPage(null); setDropPage(null); setMoveNotice("");
    try {
      if (!(await save())) return;
      const revision = current.current?.id === source.id ? current.current.revision : source.revision;
      const next: Page = await api('/api/pages/' + source.id, 'PATCH', { parent_id: parent, revision });
      if (current.current?.id === next.id) {
        // Preserve edits typed while the move request was in flight.
        current.current = { ...current.current, parent_id: next.parent_id, revision: next.revision, updated: next.updated };
        setPage(current.current);
      }
      if (parent) setExpanded(prev => new Set([...prev, parent]));
      await refresh();
      setMoveNotice(parent ? `Moved into ${active.find(p => p.id === parent)?.title || 'Untitled'}.` : 'Moved to top-level pages.');
    } catch (e) { setError((e as Error).message); }
    finally { movingPage.current = false; }
  };
  const pageDropEvents = (parent: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canDropPage(parent)) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
      setDropPage(parent || 'root');
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropPage(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation(); void dropInto(parent);
    },
  });
  const tree = (items: Summary[], depth = 0): React.ReactNode =>
    items.map((p) => (
      <React.Fragment key={p.id}>
        <div
          className={`tree-row ${area === "page" && page?.id === p.id ? "active" : ""} ${dragPage === p.id ? 'page-dragging' : ''} ${dropPage === p.id ? 'page-drop-target' : ''}`}
          data-page-id={p.id}
          draggable
          onDragStart={e => {
            if (movingPage.current) { e.preventDefault(); return; }
            e.stopPropagation(); e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-lumen-page', p.id);
            setDragPage(p.id); setMoveNotice('');
          }}
          onDragEnd={() => { setDragPage(null); setDropPage(null); }}
          {...pageDropEvents(p.id)}
          style={{ paddingLeft: 10 + depth * 14 }}
        >
          <button
            className={`chevron ${expanded.has(p.id) ? "expanded" : ""}`}
            aria-label={`Expand ${p.title}`}
            onClick={() => {
              const next = new Set(expanded);
              next.has(p.id) ? next.delete(p.id) : next.add(p.id);
              setExpanded(next);
            }}
          >
            <ChevronRight size={14} />
          </button>
          <button className="tree-title" onClick={() => void open(p.id)}>
            <span>{p.icon}</span>
            <span>{p.title || "Untitled"}</span>
          </button>
          <button
            className="tree-add"
            title="Add subpage"
            onClick={() => void create(p.id)}
          >
            <Plus size={14} />
          </button>
        </div>
        {expanded.has(p.id) &&
          tree(
            active.filter((c) => c.parent_id === p.id),
            depth + 1,
          )}
      </React.Fragment>
    ));
  const draftDownload = () => {
    const draft = page && localStorage.getItem("lumen-page-draft:" + page.id);
    download(draft ? JSON.parse(draft) : current.current, "lumen-page-draft");
  };
  const recoverDraft = async () => {
    if (!page) return;
    try {
      const raw = localStorage.getItem("lumen-page-draft:" + page.id);
      const draft: Page = raw ? JSON.parse(raw) : current.current;
      const next = await api("/api/pages", "POST", {
        title: (draft.title || "Untitled") + " (recovered)",
        document: draft.document,
      });
      dirty.current = false;
      blocked.current = false;
      await refresh();
      await open(next.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const openRecordPage=async(document:any[],blockId:string,recordId:string)=>{
    if(!current.current)return;
    edit({document});
    if(!(await save()))return;
    try {
      const parent=current.current;
      const next=await api(`/api/pages/${parent.id}/record-page`,'POST',{revision:parent.revision,block_id:blockId,record_id:recordId});
      await refresh();setExpanded(previous=>new Set([...previous,parent.id]));await open(next.id);
    }catch(e){setError((e as Error).message);}
  };
  return (
    <RecordPageNavigation.Provider value={openRecordPage}><div className={`workspace ${side ? "" : "sidebar-closed"}`}>
      {side && (
        <aside>
          <div className="workspace-label">
            
            <strong>YOUR PAGES</strong>
            <button title="Collapse pages sidebar" aria-label="Collapse pages sidebar" aria-expanded={true} onClick={() => setSide(false)}>
              <PanelLeftClose size={17} />
            </button>
          </div>
          <button className="nav-row" onClick={() => setSearch(true)}>
            <Search size={17} /> Search pages <kbd>Ctrl K</kbd>
          </button>
          <button
            className={`nav-row ${area === "home" && !templates && !radar ? "active" : ""}`}
            onClick={() => void go("home")}
          >
            <LayoutGrid size={17} /> Your workspace
          </button>
          <button className="nav-row" onClick={() => void create()}>
            <Plus size={17} /> New page
          </button>
          <button className={`nav-row ${templates ? "active" : ""}`} onClick={async()=>{if(await save()){setTemplates(true);setRadar(false);setMenu(false);}}}><Copy size={17}/>Templates</button>
          <button className={`nav-row ${radar ? "active" : ""}`} aria-expanded={radar} onClick={async()=>{if(await save()){setRadar(true);setTemplates(false);setMenu(false);}}}><LayoutGrid size={17}/>Action radar</button>
          {active.some((p) => p.favorite) && (
            <>
              <div className="section-label">Favorites</div>
              {active
                .filter((p) => p.favorite)
                .map((p) => (
                  <button
                    className="nav-row"
                    key={p.id}
                    onClick={() => void open(p.id)}
                  >
                    <span>{p.icon}</span>
                    <span className="truncate">{p.title || "Untitled"}</span>
                  </button>
                ))}
            </>
          )}
          <div className={`section-label page-root-drop ${dragPage ? "drag-active" : ""} ${dropPage === "root" ? "page-drop-target" : ""}`} {...pageDropEvents(null)}>
            {dragPage ? "Drop here for top level" : "Private pages"}{" "}
            <button title="New page" onClick={() => void create()}>
              <Plus size={14} />
            </button>
          </div>
          <div className="page-tree">
            {tree(roots)}
            {!roots.length && (
              <p className="sidebar-hint">No pages yet.</p>
            )}
          </div>
          <p className="page-move-notice" role="status">{moveNotice}</p>
          <div className="sidebar-footer">
            <button
              className="nav-row"
              onClick={async () => {
                try {
                  setLegacy((await api("/api/pages-legacy")).sheets);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <FolderInput size={16} /> Import existing sheets
            </button>
            <button className="nav-row" onClick={() => void go("trash")}>
              <Trash2 size={16} /> Trash
            </button>
            <small>Stored on this computer</small>
          </div>
        </aside>
      )}
      <main>
        <header>
          {!side && (
            <button title="Expand pages sidebar" aria-label="Expand pages sidebar" aria-expanded={false} onClick={() => setSide(true)}>
              <PanelLeft size={18} />
            </button>
          )}
          <button className="breadcrumb" aria-label="Go to workspace overview" onClick={() => void go("home")}>
            Your workspace
          </button>
          {!templates && !radar && area === "page" && page && (
            <>
              <ChevronRight size={13} />
              {page.parent_id && (
                <>
                  <button
                    className="breadcrumb"
                    onClick={() => void open(page.parent_id!)}
                  >
                    {active.find((p) => p.id === page.parent_id)?.title ||
                      "Parent page"}
                  </button>
                  <ChevronRight size={13} />
                </>
              )}
              <span className="truncate">{page.title || "Untitled"}</span>
            </>
          )}
          {(templates || radar) && <><ChevronRight size={13}/><span>{templates ? "Templates" : "Action radar"}</span></>}
          <div className="header-actions">
            <button title="Page templates" aria-label="Page templates" onClick={async()=>{if(await save()){setTemplates(true);setRadar(false);setMenu(false);}}}><Copy size={16}/></button>
            <button title="Action radar" aria-label="Action radar" aria-expanded={radar} onClick={async()=>{if(await save()){setRadar(true);setTemplates(false);setMenu(false);}}}><LayoutGrid size={16}/></button>
            {!templates && !radar && area === "page" && page && (
              <>
                <span
                  className={`save-state ${status === "Not saved" ? "failed" : ""}`}
                  role="status"
                >
                  {status === "Saved" ? "✓ " : ""}
                  {status}
                </span>
                <button
                  title={page.favorite ? "Remove favorite" : "Add to favorites"}
                  onClick={() => void mutate({ favorite: !page.favorite })}
                >
                  <Star
                    size={18}
                    fill={page.favorite ? "currentColor" : "none"}
                  />
                </button>
                <button
                  title="Page options"
                  aria-expanded={menu}
                  onClick={() => setMenu(!menu)}
                >
                  <MoreHorizontal size={21} />
                </button>
              </>
            )}
          </div>
        </header>
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            {page && (
              <>
                <button onClick={draftDownload}>Download draft</button>
                <button onClick={() => void recoverDraft()}>
                  Recover as new page
                </button>
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        "Reload the saved page? Your local draft will remain available for recovery.",
                      )
                    ) {
                      dirty.current = false;
                      blocked.current = false;
                      void open(page.id);
                    }
                  }}
                >
                  Reload saved page
                </button>
                <button
                  onClick={async () => {
                    blocked.current = false;
                    if (dirty.current) {
                      setError("");
                      await save();
                    } else await open(page.id);
                  }}
                >
                  Retry
                </button>
              </>
            )}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {templates && <TemplateLibrary busy={loading} onCreate={createFromTemplate} />}
        {radar && <ActionRadar tasks={tasks} total={taskCount} busy={radarBusy} error={radarError} onOpen={async task=>{if(await open(task.page_id)){setJumpTarget(task.block_id);}}} />}
        {menu && page && (
          <div className="page-menu">
            <button onClick={async()=>{if(!(await save())||!current.current)return;try{const id=current.current.id;const data=await api(`/api/pages/${id}/history`);setHistory({id,versions:data.versions});setMenu(false);}catch(e){setError((e as Error).message);}}}>Page history</button>
            <button
              onClick={() => {
                download(current.current, page.title || "Untitled");
                setMenu(false);
              }}
            >
              <Download size={16} /> Export page JSON
            </button>
            <button
              onClick={async () => {
                if (!(await save())) return;
                try {
                  const next = await api("/api/pages", "POST", {
                    title: (current.current?.title || "Untitled") + " (copy)",
                    document: current.current?.document,
                    parent_id: page.parent_id,
                  });
                  await refresh();
                  await open(next.id);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <Copy size={16} /> Duplicate page
            </button>
            <label>
              Move to
              <select
                aria-label="Move page to"
                value={page.parent_id || ""}
                onChange={(e) =>
                  void mutate({ parent_id: e.target.value || null })
                }
              >
                <option value="">Workspace</option>
                {active
                  .filter((p) => p.id !== page.id)
                  .map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.title || "Untitled"}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className="danger"
              onClick={() => {
                if (
                  window.confirm(
                    "Move this page and all its subpages to Trash? They can be restored individually.",
                  )
                )
                  void mutate({ trashed: true });
              }}
            >
              <Trash2 size={16} /> Move to trash
            </button>
          </div>
        )}
        {!templates && !radar && (area === "page" && page ? (
          <div className="page-scroll">
            <div className={`cover ${page.cover}`} style={coverStyle(page.cover)} hidden={!page.cover} />
            <article key={page.id}>
              <PageAppearance key={page.id} icon={page.icon} cover={page.cover}
                onChange={data=>{edit(data);setPage({...page,...data});}}
                upload={image=>api('/api/pages-cover','POST',{image})}/>
              <textarea
                rows={1}
                className="page-title"
                aria-label="Page title"
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && !e.shiftKey) {
                    e.preventDefault();
                    workspaceHost.querySelector<HTMLElement>(".tiptap")?.focus();
                  }
                }}
                placeholder="Untitled"
                maxLength={240}
                value={page.title}
                onChange={(e) => {
                  edit({ title: e.target.value });
                  setPage({ ...page, title: e.target.value });
                }}
              />

              <Editor
                key={`${page.id}:${editorSession}`}
                page={page}
                theme={theme}
                childPage={() => void create(page.id)}
                onChange={(document) => edit({ document })}
              />
              {childPages.length > 0 && (
                <div className="subpages">
                  <div className="section-label">Inside this page</div>
                  {childPages.map((p) => (
                    <button onClick={() => void open(p.id)} key={p.id}>
                      <span>{p.icon}</span>
                      {p.title || "Untitled"}
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </div>
              )}
              <button
                className="add-subpage"
                onClick={() => void create(page.id)}
              >
                <Plus size={16} /> Add a subpage
              </button>
            </article>
          </div>
        ) : (
          <div className="home">

            <div className="home-heading">
              <div>
                <h1>
                  {area === "trash" ? "Trash" : "Your workspace"}
                </h1>
                <p>
                  {area === "trash"
                    ? "Restore pages whenever you need them. Restored pages return to the workspace."
                    : "Open a recent page or find one in your library."}
                </p>
              </div>
              {area !== "trash" && (
                <div className="home-create">
                  <button onClick={async () => { if (await save()) setTemplates(true); }}><Copy size={16}/> Browse templates</button>
                  <button className="primary" onClick={() => void create()}><Plus size={17}/> New page</button>
                </div>
              )}
            </div>
            {area !== "trash" && !active.length && (
              <div className="welcome">
                <span>✦</span>
                <h2>A fresh page. Endless possibilities.</h2>
                <p>
                  Start with a thought, build a checklist, or bring your
                  existing lists into a page.
                </p>
                <button
                  className="primary"
                  onClick={() => void create(null, true)}
                >
                  Create your first page <ChevronRight size={16} />
                </button>
              </div>
            )}
            {area !== "trash" && active.length > 0 && (
              <section className="recent-pages" aria-label="Recently edited pages">
                <div className="recent-heading"><span>CONTINUE WORKING</span><small>Recently edited</small></div>
                <div className="recent-grid">{[...active].sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime()).slice(0, 3).map(p => (
                  <button key={p.id} className="recent-page" onClick={() => void open(p.id)}>
                    <span className="recent-icon">{p.icon}</span><strong>{p.title || "Untitled"}</strong>
                    <small>{new Date(p.updated).toLocaleDateString(undefined, {month: "short", day: "numeric"})}</small>
                    <ChevronRight size={15} />
                  </button>
                ))}</div>
              </section>
            )}
            <div className="list-heading">
              <span>
                {area === "trash" ? "Deleted pages" : "All pages"} ·{" "}
                {
                  libraryPages.length
                }
              </span>
              <div className="search-inline">
                <Search size={15} />
                <input
                  aria-label="Filter pages"
                  placeholder="Find a page…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
            {query.trim() && !libraryPages.length && <div className="library-empty" role="status">
              <strong>No pages match “{query}”</strong>
              <button onClick={() => setQuery("")}>Clear search</button>
            </div>}
            <div className="library-columns" aria-hidden="true"><span>PAGE NAME</span><span>LAST EDITED</span></div>
            <div className="page-cards page-library">
              {libraryPages
                .map((p) => (
                  <div className="page-card" key={p.id}>
                    <button
                      className="card-open"
                      disabled={area === "trash"}
                      onClick={() => void open(p.id)}
                    >
                      <div className={`card-cover ${p.cover || "plain"}`} style={coverStyle(p.cover)}>
                        <span>{p.icon}</span>
                      </div>
                      <strong>{p.title || "Untitled"}</strong>
                      <small>
                        {p.parent_id ? "Subpage · " : ""}
                        {new Date(p.updated).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </small>
                    </button>
                    {area === "trash" && (
                      <button
                        className="restore"
                        onClick={async () => {
                          try {
                            await api("/api/pages/" + p.id, "PATCH", {
                              revision: p.revision,
                              trashed: false,
                              parent_id: null,
                            });
                            await refresh();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        <ArrowLeft size={14} /> Restore
                      </button>
                    )}
                  </div>
                ))}
            </div>
            {area === "trash" && !pages.some((p) => p.trashed) && (
              <p className="empty-message">No pages in the trash.</p>
            )}
          </div>
        ))}
        {loading && (
          <div className="loading-screen" role="status">
            Opening page…
          </div>
        )}
      </main>
      {history&&<PageHistory versions={history.versions} onClose={()=>setHistory(null)} onRestore={async version=>{
        if(current.current?.id!==history.id||!(await save()))return;
        try{await api(`/api/pages/${history.id}/restore-version`,'POST',{version,revision:current.current.revision});await open(history.id);await refresh();setHistory(null);}catch(e){setHistory(null);setError((e as Error).message);}
      }}/>}
      {(search || legacy !== null) && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setSearch(false);
            setLegacy(null);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={search ? "Search pages" : "Import sheets"}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-top">
              <Search size={19} />
              <input
                autoFocus
                placeholder={
                  search ? "Search page titles and content…" : "Find an existing sheet…"
                }
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                aria-label="Close dialog"
                onClick={() => {
                  setSearch(false);
                  setLegacy(null);
                }}
              >
                <X size={18} />
              </button>
            </div>
            {legacy !== null && (
              <p className="import-note">
                Creates an editable copy. Original spreadsheets, formulas, and
                follow-up workflows stay in Legacy sheets. Formulas become text
                in the copy.
              </p>
            )}
            <div className="modal-results">
              {search
                ? (!searchBusy && !searchError ? searchResults : []).map((p) => (
                    <button key={p.id} onClick={() => void open(p.id)}>
                      <span>{p.icon}</span>
                      <span className="search-result-copy"><strong>{p.title || "Untitled"}</strong><small>{p.snippet}</small></span>
                      <ChevronRight size={15} />
                    </button>
                  ))
                : legacy
                    ?.filter((p) =>
                      p.title.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((p) => (
                      <button
                        key={p.id}
                        onClick={async () => {
                          if (!(await save())) return;
                          try {
                            const next = await api(
                              "/api/pages-import/" + p.id,
                              "POST",
                              {},
                            );
                            await refresh();
                            setLegacy(null);
                            await open(next.id);
                          } catch (e) {
                            setError((e as Error).message);
                            setLegacy(null);
                          }
                        }}
                      >
                        <FileText size={17} />
                        {p.title}
                        <span className="muted">Import copy</span>
                      </button>
                    ))}
              {(search
                ? !searchBusy && !searchError && searchResults.length === 0
                : legacy?.length === 0) && (
                <p className="empty-message">Nothing here yet.</p>
              )}
              {search && searchBusy && <p className="empty-message" role="status">Searching saved pages…</p>}
              {search && searchError && <p className="empty-message" role="alert">{searchError}</p>}
            </div>
            <div className="modal-footer">
              Esc to close · Pages are private to this local Lumen installation
            </div>
          </div>
        </div>
      )}
    </div></RecordPageNavigation.Provider>
  );
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="fatal">
        <h1>We couldn’t display this page.</h1>
        <p>
          Your saved pages are still on this computer. Reload to return to your
          workspace.
        </p>
        <button onClick={() => location.reload()}>Reload Pages</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(workspaceHost).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
window.dispatchEvent(new CustomEvent("lumen-workspace-ready"));
