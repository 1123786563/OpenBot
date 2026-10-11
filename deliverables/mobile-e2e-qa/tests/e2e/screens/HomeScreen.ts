// screens/HomeScreen.ts —— Page Object：首页
import { $ } from '@wdio/globals';

class HomeScreen {
  get avatar()           { return $('~home_avatar'); }
  get tabMine()          { return $('~tab_mine'); }
  get tabMineLabel()     { return $('~tab_mine_label'); }
  get searchBox()        { return $('~home_search_box'); }
  get searchInput()      { return $('~search_input'); }
  get searchSubmit()     { return $('~search_submit'); }
  get contentCard()      { return $('~home_content_card'); }
  get skeleton()         { return $('~home_skeleton'); }

  get mineNickname()     { return $('~mine_nickname'); }

  async search(keyword: string) {
    await this.searchBox.click();
    await this.searchInput.setValue(keyword);
    await this.searchSubmit.click();
  }
}
export default new HomeScreen();
