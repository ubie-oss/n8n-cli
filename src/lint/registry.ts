import type { LintConfig } from "./config.ts";
import { getRuleOptions, getRuleSeverity, isRuleEnabled, type RuleConfig } from "./config.ts";
import type { Rule, Severity } from "./rules/rule.ts";

/** RuleWithConfig pairs a Rule with its configured severity */
export interface RuleWithConfig {
  rule: Rule;
  severity: Severity;
  options?: Record<string, unknown>;
  /** The project layer that produced this rule; absent for global rules. */
  projectId?: string;
}

/** RuleRegistry manages all available lint rules */
export class RuleRegistry {
  private rules = new Map<string, Rule>();

  /** Register adds a rule to the registry */
  register(rule: Rule): void {
    this.rules.set(rule.name, rule);
  }

  /** Get returns a rule by name, or undefined if not found */
  get(name: string): Rule | undefined {
    return this.rules.get(name);
  }

  /** All returns all registered rules */
  all(): Rule[] {
    return Array.from(this.rules.values());
  }

  /** Names returns all registered rule names */
  names(): string[] {
    return Array.from(this.rules.keys());
  }

  /** EnabledRulesWithConfig returns rules filtered by config with their configured severities */
  enabledRulesWithConfig(
    config: LintConfig | null,
    disabledRules?: string[],
    projectId?: string,
  ): RuleWithConfig[] {
    const result: RuleWithConfig[] = [];
    const disabledSet = new Set(disabledRules ?? []);
    const projectRules = projectId ? config?.projectRulesConfig.get(projectId) : undefined;

    for (const [name, rule] of this.rules) {
      // Check CLI --disable-rule
      if (disabledSet.has(name)) continue;

      // The global and project layers are independent. Turning a rule off
      // globally prevents only the global execution; a matching project may
      // still opt into its own configuration of that rule.
      if (isRuleEnabled(config, name)) {
        let severity: Severity = rule.defaultSeverity;
        const configuredSeverity = getRuleSeverity(config, name);
        if (configuredSeverity === "error" || configuredSeverity === "warning") {
          severity = configuredSeverity;
        }

        result.push({ rule, severity, options: getRuleOptions(config, name) });
      }

      // Project rules are an additional policy layer. They never turn off or
      // replace a global rule: if the same rule is configured in both layers,
      // both option sets run and the engine coalesces identical violations.
      const projectRuleConfig = projectRules?.get(name);
      if (projectId && projectRuleConfig?.enabled) {
        result.push({
          rule,
          severity: configuredRuleSeverity(rule.defaultSeverity, projectRuleConfig),
          options: projectRuleConfig.options,
          projectId,
        });
      }
    }

    return result;
  }
}

function configuredRuleSeverity(defaultSeverity: Severity, config: RuleConfig): Severity {
  return config.severity === "error" || config.severity === "warning"
    ? config.severity
    : defaultSeverity;
}
