const wardrobeService = require("../../services/wardrobe-service");
const { SEASONS, DEFAULT_TEMP_RANGES } = require("../../constants/recommendation");
const { ensurePrivacyAuthorized } = require("../../utils/privacy");

const TYPES = [
  { value: "top", label: "上衣" },
  { value: "bottom", label: "下装" },
  { value: "shoes", label: "鞋子" },
  { value: "accessory", label: "配饰" }
];

const emptyForm = () => ({
  type: "top",
  name: "",
  color: "",
  style: "",
  season: "all",
  tempMin: DEFAULT_TEMP_RANGES.all.min,
  tempMax: DEFAULT_TEMP_RANGES.all.max,
  mainColor: "",
  tagsInput: "",
  imageUrl: ""
});

function splitTags(value) {
  return String(value || "")
    .split(/[,\s，、/]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function getTempRange(item) {
  if (item && item.tempRange && Number.isFinite(Number(item.tempRange.min)) && Number.isFinite(Number(item.tempRange.max))) {
    return {
      min: Number(item.tempRange.min),
      max: Number(item.tempRange.max)
    };
  }
  return DEFAULT_TEMP_RANGES[(item && item.season) || "all"] || DEFAULT_TEMP_RANGES.all;
}

Page({
  data: {
    types: TYPES,
    typeLabels: TYPES.map((type) => type.label),
    seasons: SEASONS,
    seasonLabels: SEASONS.map((season) => season.label),
    typeIndex: 0,
    seasonIndex: SEASONS.findIndex((season) => season.value === "all"),
    activeType: "top",
    showForm: false,
    loading: false,
    saving: false,
    analyzing: false,
    form: emptyForm(),
    editingId: "",
    items: [],
    filteredItems: []
  },

  onShow() {
    this.loadItems();
  },

  async loadItems() {
    this.setData({ loading: true });
    try {
      const items = await wardrobeService.getWardrobe();
      this.setData({ items, loading: false }, this.refreshFilteredItems);
    } catch (err) {
      console.warn("load wardrobe failed", err);
      this.setData({ loading: false }, this.refreshFilteredItems);
      wx.showToast({ title: "衣橱加载失败", icon: "none" });
    }
  },

  refreshFilteredItems() {
    const filteredItems = this.data.items.filter((item) => item.type === this.data.activeType);
    this.setData({ filteredItems });
  },

  changeType(event) {
    this.setData({ activeType: event.currentTarget.dataset.type }, this.refreshFilteredItems);
  },

  openForm() {
    const activeIndex = TYPES.findIndex((type) => type.value === this.data.activeType);
    this.setData({
      showForm: true,
      typeIndex: activeIndex >= 0 ? activeIndex : 0,
      seasonIndex: SEASONS.findIndex((season) => season.value === "all"),
      editingId: "",
      form: {
        ...emptyForm(),
        type: this.data.activeType
      }
    });
  },

  editItem(event) {
    const id = event.currentTarget.dataset.id;
    const item = this.data.items.find((candidate) => candidate.id === id);
    if (!item) return;
    const typeIndex = TYPES.findIndex((type) => type.value === item.type);
    const seasonIndex = SEASONS.findIndex((season) => season.value === (item.season || "all"));
    const tempRange = getTempRange(item);
    this.setData({
      showForm: true,
      editingId: item.id,
      typeIndex: typeIndex >= 0 ? typeIndex : 0,
      seasonIndex: seasonIndex >= 0 ? seasonIndex : this.data.seasonIndex,
      form: {
        type: item.type,
        name: item.name,
        color: item.color || "",
        style: item.style || "",
        season: item.season || "all",
        tempMin: tempRange.min,
        tempMax: tempRange.max,
        mainColor: item.mainColor || item.color || "",
        tagsInput: Array.isArray(item.tags) ? item.tags.join("、") : "",
        imageUrl: item.imageFileId || item.imageUrl || "",
        imageFileId: item.imageFileId || ""
      }
    });
  },

  closeForm() {
    this.setData({ showForm: false, editingId: "", form: emptyForm() });
  },

  changeFormType(event) {
    const typeIndex = Number(event.detail.value);
    this.setData({
      typeIndex,
      "form.type": TYPES[typeIndex].value
    });
  },

  changeSeason(event) {
    const seasonIndex = Number(event.detail.value);
    const season = SEASONS[seasonIndex] || SEASONS[0];
    const range = DEFAULT_TEMP_RANGES[season.value] || DEFAULT_TEMP_RANGES.all;
    this.setData({
      seasonIndex,
      "form.season": season.value,
      "form.tempMin": range.min,
      "form.tempMax": range.max
    });
  },

  updateForm(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: event.detail.value });
  },

  async chooseImage() {
    try {
      await ensurePrivacyAuthorized();
    } catch (err) {
      wx.showToast({ title: "同意隐私政策后可选择图片", icon: "none" });
      return;
    }

    const handleFile = (file) => {
      if (!file) return;
      if (file.size && file.size > 5 * 1024 * 1024) {
        wx.showToast({ title: "图片不能超过5MB", icon: "none" });
        return;
      }
      this.setData({ "form.imageUrl": file.tempFilePath || file.path || file });
    };

    const fallbackChooseImage = () => {
      wx.chooseImage({
        count: 1,
        sizeType: ["compressed", "original"],
        sourceType: ["album", "camera"],
        success: (res) => {
          handleFile({
            tempFilePath: res.tempFilePaths && res.tempFilePaths[0],
            size: res.tempFiles && res.tempFiles[0] && res.tempFiles[0].size
          });
        },
        fail: (err) => {
          if (err && err.errMsg && err.errMsg.includes("cancel")) return;
          console.warn("chooseImage failed", err);
          wx.showToast({ title: (err && err.errMsg) || "没有选中图片", icon: "none" });
        }
      });
    };

    if (!wx.chooseMedia) {
      fallbackChooseImage();
      return;
    }

    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (res) => {
        handleFile(res.tempFiles && res.tempFiles[0]);
      },
      fail: (err) => {
        if (err && err.errMsg && err.errMsg.includes("cancel")) return;
        console.warn("chooseMedia failed, fallback to chooseImage", err);
        fallbackChooseImage();
      }
    });
  },

  async saveItem() {
    const form = {
      ...this.data.form,
      name: this.data.form.name.trim(),
      color: this.data.form.color.trim(),
      style: this.data.form.style.trim(),
      season: this.data.form.season || "all",
      tempRange: {
        min: Number(this.data.form.tempMin),
        max: Number(this.data.form.tempMax)
      },
      mainColor: (this.data.form.mainColor || this.data.form.color).trim(),
      tags: splitTags(this.data.form.tagsInput || this.data.form.style)
    };

    if (!form.name) {
      wx.showToast({ title: "请填写衣物名称", icon: "none" });
      return;
    }

    if (!Number.isFinite(form.tempRange.min) || !Number.isFinite(form.tempRange.max) || form.tempRange.min > form.tempRange.max) {
      wx.showToast({ title: "请填写有效温度区间", icon: "none" });
      return;
    }

    const isEditing = Boolean(this.data.editingId);
    this.setData({ saving: true });
    try {
      const item = isEditing
        ? await wardrobeService.updateClothing(this.data.editingId, form)
        : await wardrobeService.saveClothing(form);
      this.setData({
        activeType: item.type,
        showForm: false,
        editingId: "",
        form: emptyForm(),
        saving: false
      });
      this.loadItems();
      wx.showToast({ title: isEditing ? "已更新衣物" : "已加入衣橱", icon: "success" });
    } catch (err) {
      console.warn("save wardrobe item failed", err);
      this.setData({ saving: false });
      wx.showToast({ title: isEditing ? "更新失败" : "保存失败", icon: "none" });
    }
  },

  async analyzeImage() {
    if (!this.data.form.imageUrl) {
      wx.showToast({ title: "请先添加图片", icon: "none" });
      return;
    }

    this.setData({ analyzing: true });
    try {
      const result = await wardrobeService.analyzeClothing(this.data.form);
      const nextForm = {
        ...this.data.form,
        imageUrl: result.imageFileId || this.data.form.imageUrl,
        type: result.type || this.data.form.type,
        name: this.data.form.name || result.name || "",
        color: this.data.form.color || result.color || "",
        style: this.data.form.style || result.style || ""
      };
      const typeIndex = TYPES.findIndex((type) => type.value === nextForm.type);
      this.setData({
        form: nextForm,
        typeIndex: typeIndex >= 0 ? typeIndex : this.data.typeIndex,
        analyzing: false
      });
      wx.showToast({ title: "分析完成", icon: "success" });
    } catch (err) {
      this.setData({ analyzing: false });
      wx.showToast({ title: "AI分析失败，可手动填写", icon: "none" });
    }
  },

  deleteItem(event) {
    const id = event.currentTarget.dataset.id;
    const item = this.data.items.find((candidate) => candidate.id === id);
    if (!item) return;
    wx.showModal({
      title: "删除衣物",
      content: "删除后暂时不能恢复，确认删除吗？",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const items = await wardrobeService.deleteClothing(item);
          this.setData({ items }, this.refreshFilteredItems);
          wx.showToast({ title: "已删除衣物", icon: "success" });
        } catch (err) {
          console.warn("delete wardrobe item failed", err);
          wx.showToast({ title: "删除失败，请重试", icon: "none" });
        }
      }
    });
  }
});
