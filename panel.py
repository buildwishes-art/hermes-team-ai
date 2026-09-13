"""Multi-model panel: race for speed, or make the models talk to each other.

Two shapes over the same primitive (`async_call_llm`):

* **race** — every model gets the bare question at once; the first usable
  answer wins and the rest are cancelled. Speed is the only criterion, so
  nothing is judged or merged.
* **discuss** — the models take turns. Each one reads the transcript so far
  and is asked to address peers by ``@model``: fill what is missing, correct
  what is wrong, or say the panel is done. This is the mode that produces the
  worked-out answer; race is for when you only want one fast.

Both name their models explicitly. There is no "use all configured models"
default: a panel that quietly fans out to everything you have configured is a
bill you did not agree to.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

#: A model that emits this (alone on a line, any case) is saying the panel has
#: converged. Checked as a whole word so a model *discussing* the marker does
#: not end the round.
CONCLUDE_MARKER = "PANEL_DONE"
_CONCLUDE_RE = re.compile(rf"(?:^|\n)\s*{CONCLUDE_MARKER}\s*(?:$|\n)", re.IGNORECASE)

DEFAULT_ROUNDS = 3
MAX_ROUNDS = 8
DEFAULT_TIMEOUT = 120.0


@dataclass
class Turn:
    #: What the caller asked for — may be a router alias like `combo/free-first`.
    model: str
    text: str
    seconds: float
    #: What the provider said actually answered. Differs from `model` whenever
    #: the upstream resolves the request itself: a combo picks a link in its
    #: chain, an "auto" alias picks a tier. The panel is exactly where this
    #: matters — "@free-first said X" names a routing rule, not a speaker, and
    #: two panelists both routed through the same combo would share a handle.
    resolved: Optional[str] = None

    @property
    def speaker(self) -> str:
        """The model to credit: the responder when known, else the request."""
        return self.resolved or self.model


def _strip_think(text: str) -> str:
    """Drop ``<think>…</think>`` blocks.

    Several routed models (GLM, Kimi) emit raw reasoning inline rather than in
    a separate field. Feeding that back into the next panelist wastes context
    on a monologue and invites it to imitate the format.
    """
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def _short(model: str) -> str:
    """`huggingchat/zai-org/GLM-5.3` → `GLM-5.3`, for readable @handles."""
    return model.rsplit("/", 1)[-1] or model


async def _ask(
    model: str,
    messages: List[Dict[str, str]],
    *,
    timeout: float,
    max_tokens: Optional[int],
) -> Turn:
    """One model, one turn. Raises on failure — callers decide what that means."""
    from agent.auxiliary_client import async_call_llm, extract_content_or_reasoning

    started = time.monotonic()
    response = await async_call_llm(
        task="call",
        model=model,
        messages=messages,
        timeout=timeout,
        max_tokens=max_tokens,
    )
    text = _strip_think(extract_content_or_reasoning(response) or "")
    reported = getattr(response, "model", None)
    resolved = reported.strip() if isinstance(reported, str) and reported.strip() else None
    return Turn(
        model=model,
        text=text,
        seconds=round(time.monotonic() - started, 2),
        resolved=resolved,
    )


# ── race ────────────────────────────────────────────────────────────────────


async def run_race(
    question: str,
    models: Sequence[str],
    *,
    timeout: float = DEFAULT_TIMEOUT,
    max_tokens: Optional[int] = None,
) -> Dict[str, Any]:
    """First usable answer wins; the rest are cancelled.

    "Usable" excludes a model that returns empty text — a fast blank is not a
    win. Losers are still reported (name + elapsed) so the caller can see what
    the race actually cost, rather than only what it returned.
    """
    if not models:
        return {"error": "no models given"}

    messages = [{"role": "user", "content": question}]
    tasks = {
        asyncio.ensure_future(_ask(m, messages, timeout=timeout, max_tokens=max_tokens)): m
        for m in models
    }

    winner: Optional[Turn] = None
    failures: List[Dict[str, str]] = []
    pending = set(tasks)

    while pending and winner is None:
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            model = tasks[task]
            try:
                turn = task.result()
            except Exception as exc:  # one model failing must not end the race
                failures.append({"model": model, "error": str(exc)[:200]})
                continue
            if turn.text:
                winner = turn
                break
            failures.append({"model": model, "error": "empty response"})

    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)

    if winner is None:
        return {"mode": "race", "error": "every model failed", "failures": failures}

    return {
        "mode": "race",
        "winner": winner.speaker,
        "requested": winner.model,
        "seconds": winner.seconds,
        "answer": winner.text,
        "also_ran": [m for t, m in tasks.items() if m != winner.model],
        "failures": failures,
    }


# ── discuss ─────────────────────────────────────────────────────────────────


#: What the panel is FOR. The turn-taking machinery is identical in every mode
#: — only the brief changes, because "discuss it", "plan it" and "build it"
#: want different shapes of turn out of the same models.
MODE_BRIEFS: Dict[str, Dict[str, str]] = {
    "discuss": {
        "goal": "answering a user's question together",
        "first": "You are first — answer it directly and briefly.",
        "rules": (
            "- Add what is missing, or correct what a peer got wrong.\n"
            "- Do not repeat a point that has already been made.\n"
            "- Do not restate the whole answer; this is a conversation, not a rewrite."
        ),
    },
    "plan": {
        "goal": "producing ONE agreed plan for the user's goal",
        "first": "You are first — propose the initial ordered steps.",
        "rules": (
            "- Propose concrete, ordered steps — not principles or encouragement.\n"
            "- Challenge a step you think is wrong, missing, or out of order, and say why.\n"
            "- Name risks and unknowns; a plan that hides them is worse than a short one.\n"
            "- Build on the steps already proposed instead of restarting the list.\n"
            "- Do not write the implementation. Planning is the job here."
        ),
    },
    "build": {
        "goal": "producing ONE working artifact the user asked for",
        "first": "You are first — draft the artifact, complete and runnable.",
        "rules": (
            "- Later turns review and revise what exists; they do not start over.\n"
            "- Quote the specific part you are changing, then give the replacement.\n"
            "- Say what was wrong with it — a revision without a reason is noise.\n"
            "- Keep it complete; do not leave a placeholder for a peer to fill.\n"
            "- Do not redesign because you would have started differently."
        ),
    },
}


def _discussion_system(
    models: Sequence[str],
    self_model: str,
    known: Optional[Dict[str, str]] = None,
    mode: str = "discuss",
) -> str:
    """`known` maps a requested model id to the name it actually answered as.

    Before a panelist has spoken there is nothing to resolve, so its requested
    id stands in; once it has, peers are introduced by the model that really
    replied.
    """
    known = known or {}
    brief = MODE_BRIEFS.get(mode) or MODE_BRIEFS["discuss"]
    peers = [f"@{_short(known.get(m, m))}" for m in models if m != self_model]
    return (
        f"You are {_short(self_model)}, one of {len(models)} models on a panel "
        f"{brief['goal']}. The others are: {', '.join(peers)}.\n\n"
        "Read the panel transcript so far, then contribute ONE short turn:\n"
        f"{brief['rules']}\n"
        f"- Address a peer directly by handle when you reply to them, e.g. {peers[0] if peers else '@peer'}.\n\n"
        f"When the panel has genuinely finished and you have nothing to add, "
        f"reply with exactly {CONCLUDE_MARKER} on its own line and nothing else."
    )


def _transcript_text(question: str, turns: Sequence[Turn]) -> str:
    """Frame the state as a live panel, not a pasted document.

    The first pass labelled it plainly (``USER: …`` then the turns) and a
    panelist opened with "it looks like you shared a conversation with another
    AI" — reading the transcript as something handed to it for review rather
    than a room it is standing in. The framing lines below are what stop that:
    they name the panel as ongoing and ask for the next turn.
    """
    lines = [
        "PANEL IN PROGRESS — you are a participant, not a reviewer.",
        "",
        f"The user asked: {question}",
        "",
        "Turns so far:",
    ]
    for t in turns:
        # `speaker`, not `model`: a panelist entered as `combo/free-first`
        # answered as some concrete model, and that is who the next panelist
        # must address. Crediting the alias would have every combo-routed turn
        # share one handle and hide who actually spoke.
        lines.append(f"@{_short(t.speaker)}: {t.text}")
    lines += ["", "Your turn. Speak to the panel, not about it."]
    return "\n".join(lines)


async def run_discussion(
    question: str,
    models: Sequence[str],
    *,
    rounds: int = DEFAULT_ROUNDS,
    timeout: float = DEFAULT_TIMEOUT,
    max_tokens: Optional[int] = None,
    should_stop: Optional[Any] = None,
    mode: str = "discuss",
) -> Dict[str, Any]:
    """Models take turns, each reading what the others said.

    ``mode`` selects the brief (see :data:`MODE_BRIEFS`) — discuss, plan, or
    build. The turn-taking, convergence and failure handling are identical
    across all three; only what the panelists are asked to produce differs.

    Stops on whichever comes first: the round budget, every model signalling
    ``PANEL_DONE`` in the same round, or ``should_stop()`` returning true —
    that last one is how an interrupt reaches a panel already in flight.

    A model that fails is recorded and skipped for that round only; one dead
    panelist should not end a conversation the others can still carry.
    """
    if len(models) < 2:
        return {"error": "a panel needs at least two models"}
    if mode not in MODE_BRIEFS:
        return {"error": f"unknown mode {mode!r} — expected one of {', '.join(MODE_BRIEFS)}"}

    rounds = max(1, min(int(rounds or DEFAULT_ROUNDS), MAX_ROUNDS))
    turns: List[Turn] = []
    failures: List[Dict[str, str]] = []
    stopped_early: Optional[str] = None
    #: requested id -> the model that actually answered for it
    resolved_names: Dict[str, str] = {}

    for round_no in range(rounds):
        concluded_this_round = 0

        for model in models:
            if should_stop is not None and should_stop():
                stopped_early = "interrupted"
                break

            system = _discussion_system(models, model, resolved_names, mode)
            body = (
                _transcript_text(question, turns)
                if turns
                else f"USER: {question}\n\n({MODE_BRIEFS[mode]['first']})"
            )
            messages = [
                {"role": "system", "content": system},
                {"role": "user", "content": body},
            ]

            try:
                turn = await _ask(model, messages, timeout=timeout, max_tokens=max_tokens)
            except Exception as exc:
                failures.append({"model": model, "round": round_no + 1, "error": str(exc)[:200]})
                continue

            if not turn.text:
                failures.append({"model": model, "round": round_no + 1, "error": "empty response"})
                continue

            if _CONCLUDE_RE.search(turn.text) and len(_CONCLUDE_RE.sub("", turn.text).strip()) < 4:
                # Marker alone — this panelist is done. Not recorded as a turn:
                # "PANEL_DONE" is procedural, and putting it in the transcript
                # teaches the next model to echo it.
                concluded_this_round += 1
                continue

            if turn.resolved:
                resolved_names[model] = turn.resolved
            turns.append(turn)

        if stopped_early:
            break

        # Everyone passed in the same round: the panel has converged. A single
        # model passing means only that IT is finished, so the round continues.
        if concluded_this_round >= len(models):
            stopped_early = "converged"
            break

    return {
        "mode": mode,
        "question": question,
        "models": list(models),
        "rounds_run": min(round_no + 1, rounds) if turns or failures else 0,
        "stopped": stopped_early or "round budget reached",
        "transcript": [
            {
                # `model` is who answered — that is the name worth showing.
                # `requested` keeps the alias so a combo-routed panel is still
                # auditable after the fact.
                "model": t.speaker,
                "requested": t.model,
                "handle": f"@{_short(t.speaker)}",
                "text": t.text,
                "seconds": t.seconds,
            }
            for t in turns
        ],
        "failures": failures,
    }
