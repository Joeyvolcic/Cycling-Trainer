// UI / layout integration entry point (owned by the layout work, see doc/integrations-contract.md)
import { start as startPlatform } from './ipad.js';
import { start as startLayout } from './layout.js';
import { start as startDock } from './dock.js';
import { start as startSettingsSections } from './settings-sections.js';
import './quick-start.js';

startPlatform();
startLayout();
startDock();
startSettingsSections();
