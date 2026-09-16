export const extensionMarkdown = [
  '### Extensions', '',
  'Name | State | Notes', ':--- | :---: | ---:',
  '**API** | ~~old~~ | `a\\|b`',
  '[Guide][guide] | ~replaced~ | a\\|b',
  'Short', 'More | cells | retained | ignored', '',
  '| Empty | Table |', '| --- | --- |', '',
  '3) [X] Ship **release**', '   - [ ] Review ~draft~', '4) Normal step',
  '5) [ ] Publish [Guide][guide]', '',
  '- [x] Parent', '  1. [ ] Nested numbered task', '',
  '- [ ] Multi paragraph task', '', '  Second paragraph with ~~old~~ text.', '',
  '  | Left | Right |', '  | :- | -: |', '  | x | y |', '',
  '> - [x] Quoted task', '>   - \\[x] Literal marker', '',
  'Escaped \\~literal\\~ and `~~code~~` and ~single~ and ~~**double**~~.', '',
  '[guide]: https://example.com/guide "Guide"'
].join('\n')
