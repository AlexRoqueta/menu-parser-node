export type MenuItem = {
  name: string;
  description?: string;
  price?: string;
};

export type MenuSection = {
  section: string;
  items: MenuItem[];
};

export type ParsedMenu = {
  sourceFile: string;
  extractedAt: string;
  sections: MenuSection[];
};