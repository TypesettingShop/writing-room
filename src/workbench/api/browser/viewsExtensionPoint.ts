import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IViewContainerContribution, IViewContribution } from '../../../platform/extensions/common/extensions.js';
import { ViewContainerLocation, viewContainersRegistry, viewsRegistry } from '../../common/views.js';
import type { IViewDescriptor, ViewContainer } from '../../common/views.js';
import { contributionEntries, contributionIcon, contributionRecord, contributionWhen } from '../../services/extensions/common/contributionValidation.js';
import type { IExtensionPointUser } from '../../services/extensions/common/extensionsRegistry.js';

const containerPrefix = 'workbench.view.extension.';
const locations = new Map([
  ['activitybar', ViewContainerLocation.Sidebar],
  ['panel', ViewContainerLocation.Panel],
]);
type ViewPointUser = IExtensionPointUser<Readonly<Record<string, unknown>>>;

export class ViewsExtensionHandler extends Disposable {
  private readonly containers = new Map<string, { owner: string; container: ViewContainer }>();
  private readonly views = new Map<string, { owner: string; view: IViewDescriptor; container: ViewContainer }>();

  constructor(private readonly renderTree: (parent: HTMLElement, viewId: string) => ReturnType<IViewDescriptor['renderBody']>) {
    super();
    this._register(toDisposable(() => {
      for (const { view, container } of this.views.values()) {
        viewsRegistry.deregisterViews([view], container);
      }
      for (const { container } of this.containers.values()) {
        viewContainersRegistry.deregisterViewContainer(container);
      }
      this.views.clear();
      this.containers.clear();
    }));
  }

  acceptContainers(users: readonly ViewPointUser[]): void {
    const keep = new Set<string>();
    for (const user of users) {
      const owner = user.description.identifier.value;
      for (const [key, values] of Object.entries(user.value)) {
        const base = 'contributes.viewsContainers.' + key;
        const location = locations.get(key);
        if (location === undefined) {
          user.collector.warn(base, 'Unsupported view container location.');
          continue;
        }
        for (const [index, value] of contributionEntries(values, base, user).entries()) {
          const path = base + '.' + index;
          const entry = contributionRecord<IViewContainerContribution>(value, path, user, ['id', 'title', 'icon']);
          const icon = entry && contributionIcon(entry.icon, path + '.icon', user);
          if (!entry || !icon) {
            continue;
          }
          const id = containerPrefix + entry.id;
          let current = this.containers.get(id);
          if (current && current.owner !== owner && !keep.has(id)) {
            viewContainersRegistry.deregisterViewContainer(current.container);
            this.containers.delete(id);
            current = undefined;
          }
          if (keep.has(id) || (!current && viewContainersRegistry.get(id))) {
            user.collector.error(path + '.id', `View container '${id}' already exists.`);
            continue;
          }
          if (!current) {
            const container = viewContainersRegistry.registerViewContainer({ id, title: entry.title, icon }, location);
            this.containers.set(id, { owner, container });
          }
          keep.add(id);
        }
      }
    }
    for (const [id, { container }] of this.containers) {
      if (!keep.has(id)) {
        viewContainersRegistry.deregisterViewContainer(container);
        this.containers.delete(id);
      }
    }
  }

  containerIds(owner: string): string[] {
    return [...this.containers].filter(([, entry]) => entry.owner === owner).map(([id]) => id);
  }

  viewIds(owner: string): string[] {
    return [...this.views].filter(([, entry]) => entry.owner === owner).map(([id]) => id);
  }

  acceptViews(users: readonly ViewPointUser[], events: Map<string, Set<string>>): void {
    const keep = new Set<string>();
    for (const user of users) {
      const owner = user.description.identifier.value;
      for (const [key, values] of Object.entries(user.value)) {
        const base = 'contributes.views.' + key;
        const explorer = viewContainersRegistry.get('workbench.view.explorer');
        const container = key === 'explorer' ? explorer : this.containers.get(containerPrefix + key)?.container;
        if (!container && key !== 'explorer') {
          user.collector.warn(base, `Unknown view container '${key}'. Using Explorer.`);
        }
        const destination = container ?? explorer;
        if (!destination) {
          user.collector.error(base, 'Explorer is unavailable.');
          continue;
        }
        for (const [index, value] of contributionEntries(values, base, user).entries()) {
          const path = base + '.' + index;
          const entry = contributionRecord<IViewContribution>(value, path, user, ['id', 'name'], ['when']);
          if (!entry) {
            continue;
          }
          const when = contributionWhen(entry.when, path + '.when', user);
          if (when === false) {
            continue;
          }
          const current = this.views.get(entry.id);
          if (keep.has(entry.id) || (!current && viewsRegistry.getViewContainer(entry.id))) {
            user.collector.error(path + '.id', `View '${entry.id}' already exists.`);
            continue;
          }
          if (current?.owner !== owner || current.container !== destination) {
            if (current) {
              viewsRegistry.deregisterViews([current.view], current.container);
            }
            const view = {
              id: entry.id, name: entry.name, when,
              renderBody: (parent: HTMLElement) => this.renderTree(parent, entry.id),
            };
            viewsRegistry.registerViews([view], destination);
            this.views.set(entry.id, { owner, view, container: destination });
          }
          keep.add(entry.id);
          events.get(owner)?.add('onView:' + entry.id);
        }
      }
    }
    for (const [id, { view, container }] of this.views) {
      if (!keep.has(id)) {
        viewsRegistry.deregisterViews([view], container);
        this.views.delete(id);
      }
    }
  }
}
