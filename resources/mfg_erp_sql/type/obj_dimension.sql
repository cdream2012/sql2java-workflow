-- 物料尺寸/重量值对象，作为 t_item 的对象列内嵌存储
-- 体积重(volumetric weight)是物流计费常用口径: 体积(cm3)/5000，与实重取大者
-- 除数 5000 是空运惯例，海运/陆运不同，真实系统按承运商配置，这里固定示意

CREATE OR REPLACE TYPE t_dimension FORCE AS OBJECT (
    length_cm   NUMBER(10,2),
    width_cm    NUMBER(10,2),
    height_cm   NUMBER(10,2),
    weight_kg   NUMBER(10,3),

    MEMBER FUNCTION volume_cm3 RETURN NUMBER,
    MEMBER FUNCTION volumetric_weight_kg RETURN NUMBER,
    MEMBER FUNCTION chargeable_weight_kg RETURN NUMBER
);
/

CREATE OR REPLACE TYPE BODY t_dimension AS

    MEMBER FUNCTION volume_cm3 RETURN NUMBER IS
    BEGIN
        RETURN NVL(SELF.length_cm, 0) * NVL(SELF.width_cm, 0) * NVL(SELF.height_cm, 0);
    END volume_cm3;

    MEMBER FUNCTION volumetric_weight_kg RETURN NUMBER IS
    BEGIN
        RETURN ROUND(SELF.volume_cm3 / 5000, 3);
    END volumetric_weight_kg;

    MEMBER FUNCTION chargeable_weight_kg RETURN NUMBER IS
    BEGIN
        RETURN GREATEST(NVL(SELF.weight_kg, 0), SELF.volumetric_weight_kg);
    END chargeable_weight_kg;

END;
/
