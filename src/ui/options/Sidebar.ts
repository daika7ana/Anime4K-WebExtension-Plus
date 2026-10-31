export class Sidebar {
  private sidebar: HTMLElement;
  private toggleButton: HTMLButtonElement;
  private overlay: HTMLElement;
  private menu: HTMLElement;
  private contentSections: NodeListOf<HTMLElement>;

  constructor() {
    this.sidebar = document.getElementById('sidebar') as HTMLElement;
    this.toggleButton = document.getElementById('sidebar-toggle') as HTMLButtonElement;
    this.overlay = document.getElementById('sidebar-overlay') as HTMLElement;
    this.menu = document.getElementById('sidebar-menu') as HTMLElement;
    this.contentSections = document.querySelectorAll('.content-section');

    if (!this.sidebar || !this.toggleButton || !this.overlay || !this.menu) {
      throw new Error('Sidebar elements not found');
    }
  }

  public initialize(): void {
    this.toggleButton.addEventListener('click', this.toggle.bind(this));
    this.overlay.addEventListener('click', this.close.bind(this));
    this.menu.addEventListener('click', this.handleNavigation.bind(this));
  }

  public toggle(): void {
    this.sidebar.classList.toggle('open');
    this.overlay.classList.toggle('active');
  }

  public close(): void {
    this.sidebar.classList.remove('open');
    this.overlay.classList.remove('active');
  }

  private handleNavigation(e: Event): void {
    const target = e.target as HTMLElement;
    const menuItem = target.closest('.menu-item');

    if (!menuItem) return;

    e.preventDefault();

    // Update active state of menu items
    this.menu.querySelectorAll('.menu-item').forEach(item => item.classList.remove('active'));
    menuItem.classList.add('active');

    // Show the corresponding content section
    const sectionName = menuItem.getAttribute('data-section');
    this.contentSections.forEach(section => section.classList.remove('active'));
    const targetSection = document.getElementById(`${sectionName}-section`);
    if (targetSection) {
      targetSection.classList.add('active');
    }

    // On small screens, close sidebar after click
    if (window.innerWidth <= 900) {
      this.close();
    }
  }
}