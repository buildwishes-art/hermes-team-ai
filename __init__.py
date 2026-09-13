"""team_ai — several models on one question, racing or arguing.

Registers two tools. They share a primitive and differ only in shape:

    team_race      parallel, first usable answer wins, rest cancelled
    team_discuss   sequential rounds, each model reads the others and replies
                   to them by @handle until the panel converges

See ``panel.py`` for the mechanics. Everything here is argument handling and
result formatting — the part the model sees.
"""

from __future__ import annotations

import asyncio
import logging
import json
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

#: Appended to a panel result so a rich surface can render each turn as its own
#: bubble instead of one wall of text. An HTML comment because every other
#: surface — CLI, logs, a model reading the tool result — shows it as inert
#: noise at worst; a control character or bare JSON blob would not survive that
#: trip as harmlessly.
PANEL_PAYLOAD_PREFIX = "<!--HERMES_PANEL "
PANEL_PAYLOAD_SUFFIX = " -->"


def _payload(
    kind: str,
    turns: List[Dict[str, Any]],
    note: str = "",
    failures: Any = None,
) -> str:
    """Machine-readable tail: who spoke, as what, and what they said.

    ``note`` is a one-line summary for a surface that draws the turns itself.
    It exists because the prose above this payload repeats every turn in full:
    a renderer showing both ends up printing the panel twice. Carrying the
    header separately lets the rich surface show the header and the bubbles,
    and the plain one show the prose, without either inventing the other.

    ``failures`` rides along for the same reason — a panelist that died is
    part of what happened, and a surface that only draws `turns` would report
    a two-model panel as a one-model one with no explanation.
    """
    try:
        blob = json.dumps(
            {
                "kind": kind,
                "turns": turns,
                "note": note,
                "failures": list(failures or []),
            },
            ensure_ascii=False,
        )
    except (TypeError, ValueError):
        return ""
    return f"\n{PANEL_PAYLOAD_PREFIX}{blob}{PANEL_PAYLOAD_SUFFIX}"

_MODELS_SCHEMA = {
    "type": "array",
    "items": {"type": "string"},
    "description": (
        "Model ids to put on the panel, exactly as they appear in /v1/models "
        "(e.g. 'huggingchat/zai-org/GLM-5.3'). Required — nothing is called "
        "that you did not list."
    ),
}

RACE_SCHEMA = {
    "name": "team_race",
    "description": (
        "Ask several models the same question in parallel and return the FIRST "
        "usable answer; the others are cancelled. Use when latency matters more "
        "than depth. An empty reply does not win the race."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "The question to put to every model."},
            "models": _MODELS_SCHEMA,
            "timeout": {
                "type": "number",
                "description": "Per-model timeout in seconds (default 120).",
            },
            "max_tokens": {"type": "integer", "description": "Optional per-model output cap."},
        },
        "required": ["question", "models"],
    },
}

DISCUSS_SCHEMA = {
    "name": "team_discuss",
    "description": (
        "Put several models in conversation about one question. Each takes a turn "
        "reading what the others said, then adds what is missing or corrects what "
        "is wrong, addressing peers by @handle. Runs until the panel converges "
        "(every model passes) or the round budget is spent. Use when you want the "
        "answer worked out rather than answered fast. Needs at least two models."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "The question the panel discusses."},
            "models": _MODELS_SCHEMA,
            "rounds": {
                "type": "integer",
                "description": "Maximum rounds, 1-8 (default 3). One round = every model speaks once.",
            },
            "timeout": {
                "type": "number",
                "description": "Per-turn timeout in seconds (default 120).",
            },
            "max_tokens": {"type": "integer", "description": "Optional per-turn output cap."},
        },
        "required": ["question", "models"],
    },
}


def _panel_schema(name: str, description: str, subject: str) -> Dict[str, Any]:
    """Plan and build take the same arguments as discuss — only the brief and
    the word for the input differ, so the schema is built rather than copied."""
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": subject},
                "models": _MODELS_SCHEMA,
                "rounds": {
                    "type": "integer",
                    "description": "Maximum rounds, 1-8 (default 3). One round = every model speaks once.",
                },
                "timeout": {"type": "number", "description": "Per-turn timeout in seconds (default 120)."},
                "max_tokens": {"type": "integer", "description": "Optional per-turn output cap."},
            },
            "required": ["question", "models"],
        },
    }


PLAN_SCHEMA = _panel_schema(
    "team_plan",
    "Put several models on planning one goal. Each takes a turn proposing or "
    "challenging ordered steps, naming risks, and building on what peers already "
    "proposed — no implementation. Use before doing the work, when the approach "
    "matters more than the first idea. Needs at least two models.",
    "The goal to plan for.",
)

BUILD_SCHEMA = _panel_schema(
    "team_build",
    "Put several models on building one artifact. The first turn drafts it "
    "complete; later turns quote the part they are changing, give the "
    "replacement, and say what was wrong. Use when a draft benefits from review "
    "before you take it. Needs at least two models.",
    "What to build.",
)


def _clean_models(raw: Any) -> List[str]:
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return []
    seen: List[str] = []
    for m in raw:
        s = str(m or "").strip()
        # De-duplicated: the same model twice on a panel talks to itself, and in
        # a race it just doubles the spend on one provider.
        if s and s not in seen:
            seen.append(s)
    return seen


def _run(coro) -> Any:
    """Run an async panel from a sync tool handler.

    ``asyncio.run`` refuses to nest, and a tool handler may or may not already
    be inside a loop depending on the surface that invoked it. When a loop is
    already running, hand the work to a private one on another thread rather
    than failing.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _format_race(result: Dict[str, Any]) -> str:
    if result.get("error"):
        lines = [f"Panel race failed: {result['error']}"]
        for f in result.get("failures") or []:
            lines.append(f"  {f['model']}: {f['error']}")
        return "\n".join(lines)

    via = "" if result["winner"] == result.get("requested") else f" via {result.get('requested')}"
    out = [
        f"Winner: {result['winner']}  ({result['seconds']}s{via})",
        "",
        result["answer"],
    ]
    if result.get("also_ran"):
        out += ["", f"Cancelled: {', '.join(result['also_ran'])}"]
    for f in result.get("failures") or []:
        out.append(f"Failed: {f['model']} — {f['error']}")
    winner_turn = [
        {
            "model": result["winner"],
            "requested": result.get("requested") or result["winner"],
            "handle": "@" + str(result["winner"]).rsplit("/", 1)[-1],
            "text": result["answer"],
            "seconds": result["seconds"],
        }
    ]
    cancelled = len(result.get("also_ran") or [])
    note = f"Race · won in {result['seconds']}s"
    if cancelled:
        note += f" · {cancelled} cancelled"
    return "\n".join(out) + _payload("race", winner_turn, note, result.get("failures"))


def _format_discussion(result: Dict[str, Any]) -> str:
    if result.get("error"):
        return f"Panel discussion failed: {result['error']}"

    out = [
        f"Panel: {', '.join(result['models'])}",
        f"Rounds: {result['rounds_run']} — stopped because {result['stopped']}",
        "",
    ]
    for t in result["transcript"]:
        # The handle names who answered. When that differs from what was asked
        # for — a combo resolving to one of its links — the alias is shown in
        # parentheses rather than dropped, so the routing stays auditable.
        via = "" if t["model"] == t["requested"] else f" via {t['requested']}"
        out.append(f"{t['handle']} ({t['seconds']}s{via})")
        out.append(t["text"])
        out.append("")
    for f in result.get("failures") or []:
        out.append(f"Failed: {f['model']} (round {f['round']}) — {f['error']}")
    rounds_run = result.get("rounds_run") or 0
    note = (
        f"{result['mode'].title()} · {len(result['models'])} models · "
        f"{rounds_run} round{'' if rounds_run == 1 else 's'} · "
        f"stopped because {result['stopped']}"
    )
    return "\n".join(out).rstrip() + _payload(
        result.get("mode") or "discuss",
        result.get("transcript") or [],
        note,
        result.get("failures"),
    )


def _team_race(args: Dict[str, Any], **_kw) -> str:
    # Handlers take the argument dict positionally — `handle_meet_join(args, **_kw)`
    # is the shape the registry calls. Declaring named parameters instead made
    # `question` receive the whole dict, and the first `.strip()` raised
    # AttributeError at runtime with a message that pointed nowhere useful.
    from .panel import run_race

    args = args if isinstance(args, dict) else {}
    question = str(args.get("question") or "")
    models = args.get("models")
    timeout = args.get("timeout") or 120.0
    max_tokens = args.get("max_tokens")

    picked = _clean_models(models)
    if not question.strip():
        return "team_race needs a question."
    if not picked:
        return "team_race needs at least one model id in `models`."
    return _format_race(
        _run(run_race(question, picked, timeout=float(timeout or 120.0), max_tokens=max_tokens))
    )


def _run_panel_mode(args: Dict[str, Any], mode: str, tool: str) -> str:
    """Shared body for discuss / plan / build — they differ only by brief."""
    from .panel import run_discussion

    args = args if isinstance(args, dict) else {}
    question = str(args.get("question") or "")
    picked = _clean_models(args.get("models"))
    if not question.strip():
        return f"{tool} needs a question."
    if len(picked) < 2:
        return f"{tool} needs at least two distinct model ids — one model cannot hold a panel."
    return _format_discussion(
        _run(
            run_discussion(
                question,
                picked,
                rounds=int(args.get("rounds") or 3),
                timeout=float(args.get("timeout") or 120.0),
                max_tokens=args.get("max_tokens"),
                mode=mode,
            )
        )
    )


def _team_plan(args: Dict[str, Any], **_kw) -> str:
    return _run_panel_mode(args, "plan", "team_plan")


def _team_build(args: Dict[str, Any], **_kw) -> str:
    return _run_panel_mode(args, "build", "team_build")


def _team_discuss(args: Dict[str, Any], **_kw) -> str:
    from .panel import run_discussion

    args = args if isinstance(args, dict) else {}
    question = str(args.get("question") or "")
    models = args.get("models")
    rounds = args.get("rounds") or 3
    timeout = args.get("timeout") or 120.0
    max_tokens = args.get("max_tokens")

    picked = _clean_models(models)
    if not question.strip():
        return "team_discuss needs a question."
    if len(picked) < 2:
        return "team_discuss needs at least two distinct model ids — one model cannot hold a discussion."
    return _format_discussion(
        _run(
            run_discussion(
                question,
                picked,
                rounds=int(rounds or 3),
                timeout=float(timeout or 120.0),
                max_tokens=max_tokens,
            )
        )
    )


_TOOLS = (
    ("team_race", RACE_SCHEMA, _team_race, "🏁"),
    ("team_discuss", DISCUSS_SCHEMA, _team_discuss, "💬"),
    ("team_plan", PLAN_SCHEMA, _team_plan, "🗺️"),
    ("team_build", BUILD_SCHEMA, _team_build, "🔨"),
)


def register(ctx) -> None:
    """Register both team tools under the ``team_ai`` toolset."""
    for name, schema, handler, emoji in _TOOLS:
        ctx.register_tool(
            name=name,
            toolset="team_ai",
            schema=schema,
            handler=handler,
            emoji=emoji,
        )
    logger.debug("team_ai: registered %d tools", len(_TOOLS))
