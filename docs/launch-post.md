# LinkedIn launch post (draft)

I built a small tool for a problem I kept having: my "what should I do next?" was scattered across five places.

A branch I forgot to push. A review a teammate had been waiting on for two days. A Jira ticket due tomorrow. A standup in ten minutes. Each tool has its own inbox and its own idea of what's important.

Birddog puts them in one list on your own machine: local git, GitHub, Jira and your calendar. It ranks them with plain rules and shows why each item is there, for example "@ana requested your review 2 days ago · they are waiting on you". There are no scores to guess at.

A few things I cared about while building it:

• Local-first and read-only. It runs on 127.0.0.1, never pushes, comments or moves tickets, and keeps tokens in the OS keychain.
• Zero runtime dependencies. Plain Node and browser JavaScript, including a hand-written iCalendar parser and MCP server.
• An MCP server, so Claude Code or Claude Desktop can ask "what needs me?" and snooze or clear items.
• Keyboard-first: j/k, x for done, s for snooze, ⌘K for everything else.

You can try it with made-up data: npx @marcusferrell/birddog --demo

It's open source (MIT). Feedback and source ideas are welcome:
https://github.com/marcsalot/birddog
